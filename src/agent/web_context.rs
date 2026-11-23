use std::{
    collections::VecDeque,
    future::Future,
    sync::{Arc, Mutex},
};

use tokio::sync::OnceCell;

use super::search::ParallelMcpSession;

const MAX_CACHED_PAGES: usize = 16;

#[derive(Debug, Default)]
pub(super) struct WebContext {
    pub pages: PageCache,
    pub parallel: ParallelMcpSession,
}

type PageEntry = (String, Arc<OnceCell<Arc<str>>>);

#[derive(Debug, Default)]
pub(super) struct PageCache {
    entries: Mutex<VecDeque<PageEntry>>,
}

impl PageCache {
    pub async fn get_or_fetch<F, Fut>(&self, url: &str, fetch: F) -> Result<Arc<str>, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<String, String>>,
    {
        let mut key = reqwest::Url::parse(url).map_err(|_| "invalid URL".to_string())?;
        key.set_fragment(None);
        let key = key.to_string();
        let entry = {
            let mut entries = self
                .entries
                .lock()
                .map_err(|_| "page cache lock poisoned".to_string())?;
            let entry = entries
                .iter()
                .position(|(url, _)| url == &key)
                .and_then(|index| entries.remove(index))
                .unwrap_or_else(|| (key, Arc::new(OnceCell::new())));
            let cell = entry.1.clone();
            entries.push_back(entry);
            if entries.len() > MAX_CACHED_PAGES {
                entries.pop_front();
            }
            cell
        };
        // Failed or cancelled downloads leave the cell empty, so later reads can retry.
        entry
            .get_or_try_init(|| async { fetch().await.map(Arc::<str>::from) })
            .await
            .cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[tokio::test]
    async fn enrichment_and_fetch_url_share_cache_across_tool_settings() {
        use super::super::{
            AgentSkills, SearchHit, WebSearchDepth, append_scraped_pages, fetch_single_url,
            search_call_overrides,
        };

        // An offline URL ensures either tool would fail if it bypassed the primed cache.
        let url = "https://cached-page.invalid/article";
        let skills = AgentSkills {
            web_search: true,
            fetch_url: true,
            web_search_depth: WebSearchDepth::Light,
            web_context: Some(Arc::new(WebContext::default())),
            ..Default::default()
        };
        let full = format!("{}PAGE-END", "abcde".repeat(1000));
        skills
            .web_context
            .as_ref()
            .unwrap()
            .pages
            .get_or_fetch(url, || async { Ok(full.clone()) })
            .await
            .unwrap();
        let cloned = search_call_overrides(&skills, &serde_json::json!({ "recency": "week" }));
        let mut enriched = String::new();
        append_scraped_pages(
            &mut enriched,
            &[SearchHit {
                title: "Cached page".into(),
                url: url.into(),
                ..Default::default()
            }],
            &cloned,
        )
        .await;
        assert!(enriched.contains("abcde"));
        assert!(!enriched.contains("PAGE-END"));
        let first = fetch_single_url(url, &skills, 0, Some(1600)).await.unwrap();
        assert!(first.contains("offset=1600"));
        let last = fetch_single_url(url, &cloned, 5000, None).await.unwrap();
        assert!(last.contains("PAGE-END"));
        assert!(last.contains("End of page reached"));
        let serialized = serde_json::to_value(&skills).unwrap();
        assert!(serialized.get("web_context").is_none());
        let restored: AgentSkills = serde_json::from_value(serialized).unwrap();
        assert!(restored.web_context.is_none());
    }

    #[tokio::test]
    async fn concurrent_reads_and_pagination_download_once() {
        let cache = PageCache::default();
        let downloads = AtomicUsize::new(0);
        let fetch = || async {
            downloads.fetch_add(1, Ordering::Relaxed);
            tokio::time::sleep(Duration::from_millis(10)).await;
            Ok("abcdefghij".to_string())
        };
        let (first, second) = tokio::join!(
            cache.get_or_fetch("https://example.com/article#first", fetch),
            cache.get_or_fetch("https://example.com/article#second", fetch),
        );
        let (first, second) = (first.unwrap(), second.unwrap());
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(downloads.load(Ordering::Relaxed), 1);
        let next = cache
            .get_or_fetch("https://example.com/article", || async {
                panic!("pagination must not download again")
            })
            .await
            .unwrap();
        assert!(
            super::super::format_page_window("https://example.com/article", &next, 5, 5)
                .contains("fghij")
        );
    }

    #[tokio::test]
    async fn failed_and_cancelled_fetches_can_retry() {
        let cache = PageCache::default();
        let url = "https://example.com/article";
        assert!(
            cache
                .get_or_fetch(url, || async { Err("offline".into()) })
                .await
                .is_err()
        );
        let blocked = cache.get_or_fetch(url, std::future::pending::<Result<String, String>>);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), blocked)
                .await
                .is_err()
        );
        assert_eq!(
            &*cache
                .get_or_fetch(url, || async { Ok("retried".into()) })
                .await
                .unwrap(),
            "retried"
        );
    }

    #[tokio::test]
    async fn distinct_turns_and_query_parameters_do_not_share_content() {
        let first = PageCache::default();
        let second = PageCache::default();
        let url = "https://example.com/article?version=1";
        first
            .get_or_fetch(url, || async { Ok("old".into()) })
            .await
            .unwrap();
        assert_eq!(
            &*second
                .get_or_fetch(url, || async { Ok("new".into()) })
                .await
                .unwrap(),
            "new"
        );
        assert_eq!(
            &*first
                .get_or_fetch("https://example.com/article?version=2", || async {
                    Ok("different".into())
                })
                .await
                .unwrap(),
            "different"
        );
    }

    #[tokio::test]
    async fn cache_evicts_old_pages_without_growing() {
        let cache = PageCache::default();
        for index in 0..=MAX_CACHED_PAGES {
            cache
                .get_or_fetch(&format!("https://example.com/{index}"), || async {
                    Ok("page".into())
                })
                .await
                .unwrap();
        }
        assert_eq!(cache.entries.lock().unwrap().len(), MAX_CACHED_PAGES);
        assert_eq!(
            &*cache
                .get_or_fetch("https://example.com/0", || async { Ok("refetched".into()) })
                .await
                .unwrap(),
            "refetched"
        );
    }
}
