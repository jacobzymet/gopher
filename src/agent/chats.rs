//! Read-only retrieval. Resolve the scope and reload protected data on every call
//! so lock, deletion, profile changes, and the Settings switch take effect.
use std::sync::{Arc, OnceLock};

use regex::Regex;
use serde_json::{Value, json};

use crate::web::SharedApp;

pub(crate) struct ChatHistory {
    app: SharedApp,
    profile_id: Option<String>,
    conversation_id: String,
}

impl std::fmt::Debug for ChatHistory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChatHistory").finish_non_exhaustive()
    }
}

impl ChatHistory {
    pub(crate) fn open(app: SharedApp, conversation_id: &str) -> Option<Arc<Self>> {
        let profile_id = {
            let guard = app.lock().ok()?;
            if !retrieval_enabled(&guard.load_chat_preferences().ok()?) {
                return None;
            }
            let store = guard.load_chat_store().ok()?;
            let profile_id = if store.get("profiles").is_some() {
                Some(store.get("activeProfileId")?.as_str()?.to_owned())
            } else {
                None
            };
            scope(&store, profile_id.as_deref(), conversation_id)?;
            profile_id
        };
        Some(Arc::new(Self {
            app,
            profile_id,
            conversation_id: conversation_id.into(),
        }))
    }

    pub(crate) fn execute(
        &self,
        name: &str,
        args: &Value,
        max_bytes: usize,
    ) -> Result<String, String> {
        let app = self.app.lock().map_err(|_| "Local data is unavailable")?;
        if !retrieval_enabled(&app.load_chat_preferences()?) {
            return Err("Search past chats is disabled in Settings.".into());
        }
        let store = app.load_chat_store()?;
        let (profile, source) = scope(&store, self.profile_id.as_deref(), &self.conversation_id)
            .ok_or("This conversation's chat-retrieval scope is no longer available.")?;
        let source_project = project_id(source);
        let mut chats: Vec<&Value> = profile["conversations"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|chat| {
                chat["id"].as_str() != Some(&self.conversation_id)
                    && chat["id"].as_str().is_some_and(|id| {
                        !id.is_empty()
                            && id.len() <= 128
                            && id
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
                    })
                    && chat["incognito"].as_bool() != Some(true)
                    && project_id(chat) == source_project
            })
            .collect();
        chats.sort_by_key(|chat| std::cmp::Reverse(chat["updatedAt"].as_u64().unwrap_or(0)));
        let budget = max_bytes.clamp(1024, 12_000);
        let scope_label = if source_project.is_some() {
            "current project"
        } else {
            "non-project chats in current profile"
        };
        let result = match name {
            "list_chats" => list(&chats, args, budget, scope_label),
            "search_chats" => search(&chats, args, budget, scope_label)?,
            "read_chat" => read(&chats, args, budget, scope_label)?,
            _ => return Err("Unknown chat-retrieval tool".into()),
        };
        Ok(result.to_string())
    }
}

fn retrieval_enabled(preferences: &Value) -> bool {
    preferences["chatRetrieval"].as_bool() != Some(false)
}

fn scope<'a>(
    store: &'a Value,
    profile_id: Option<&str>,
    source_id: &str,
) -> Option<(&'a Value, &'a Value)> {
    let profile = if let Some(id) = profile_id {
        if store["activeProfileId"].as_str() != Some(id) {
            return None;
        }
        store["profiles"]
            .as_array()?
            .iter()
            .find(|profile| profile["id"].as_str() == Some(id))?
    } else {
        if store.get("profiles").is_some() {
            return None;
        }
        store
    };
    let source = profile["conversations"].as_array()?.iter().find(|chat| {
        chat["id"].as_str() == Some(source_id) && chat["incognito"].as_bool() != Some(true)
    })?;
    Some((profile, source))
}

fn project_id(chat: &Value) -> Option<&str> {
    chat["projectId"].as_str().filter(|id| !id.is_empty())
}

fn number(args: &Value, key: &str, default: usize) -> usize {
    args[key]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .unwrap_or(default)
}

fn cut(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn encoded_id(id: &str) -> String {
    id.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn metadata(chat: &Value, index: Option<usize>) -> Value {
    let id = chat["id"].as_str().unwrap_or("");
    json!({
        "chat_id": id,
        "title": cut(&chat["title"].as_str().unwrap_or("Untitled chat").chars().filter(|c| !c.is_control()).collect::<String>(), 60),
        "updated_at": chat["updatedAt"].as_u64().unwrap_or(0),
        "message_index": index,
        "url": format!("/c/{}{}", encoded_id(id), index.map(|n| format!("?message={n}")).unwrap_or_default())
    })
}

fn visible_text(message: &Value) -> Option<String> {
    let role = message["role"].as_str()?;
    if !matches!(role, "user" | "assistant") {
        return None;
    }
    let content = if let Some(text) = message["content"].as_str() {
        text.to_owned()
    } else {
        message["content"]
            .as_array()?
            .iter()
            .filter_map(|part| {
                if matches!(
                    part["type"].as_str(),
                    Some("text" | "input_text" | "output_text")
                ) {
                    part["text"].as_str()
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let text = strip_hidden(&content).trim().to_owned();
    if text.is_empty() { None } else { Some(text) }
}

fn strip_hidden(content: &str) -> String {
    static TAGS: OnceLock<Regex> = OnceLock::new();
    let tags = TAGS.get_or_init(|| Regex::new(
        r"(?is)<\s*(/?)(think|thinking|analysis|global_memory_update|memory_update|bot_memory_update|group_memory_update|bot_hold|bot_resume|bot_dm_user|bot_group_post)\b[^>]*>|\[\[\s*(/?)(think|thinking|analysis|global_memory_update|memory_update|bot_memory_update|group_memory_update|hold|resume|dm_user|group_post)\s*\]\]"
    ).unwrap());
    let mut output = String::new();
    let mut hidden = Vec::new();
    let mut cursor = 0;
    for captures in tags.captures_iter(content) {
        let token = captures.get(0).unwrap();
        if hidden.is_empty() {
            output.push_str(&content[cursor..token.start()]);
        }
        let tag = captures
            .get(2)
            .or_else(|| captures.get(4))
            .unwrap()
            .as_str()
            .to_ascii_lowercase();
        let closing = captures
            .get(1)
            .or_else(|| captures.get(3))
            .unwrap()
            .as_str()
            == "/";
        if closing {
            // Mismatched or unfinished blocks remain hidden. A different closing
            // tag must never expose the remainder of private reasoning or memory.
            if hidden.last() == Some(&tag) {
                hidden.pop();
            }
        } else if !matches!(tag.as_str(), "bot_hold" | "bot_resume" | "hold" | "resume")
            && !token.as_str().ends_with("/>")
        {
            hidden.push(tag);
        }
        cursor = token.end();
    }
    if hidden.is_empty() {
        output.push_str(&content[cursor..]);
    }
    output
}

fn page(scope: &str) -> Value {
    json!({ "scope": scope, "results": [], "next_cursor": null })
}

fn push_fits(page: &mut Value, item: Value, budget: usize) -> bool {
    page["results"].as_array_mut().unwrap().push(item);
    // Reserve room for continuation fields.
    if page.to_string().len() + 96 <= budget {
        true
    } else {
        page["results"].as_array_mut().unwrap().pop();
        false
    }
}

fn text_capacity(page: &Value, item: &Value, budget: usize, max: usize) -> usize {
    // A character can expand to six bytes when JSON-escaped. Reserve pagination
    // metadata and calculate against all the already returned entries.
    budget
        .saturating_sub(page.to_string().len() + item.to_string().len() + 128)
        .saturating_div(6)
        .min(max)
}

fn list(chats: &[&Value], args: &Value, budget: usize, scope: &str) -> Value {
    let offset = number(args, "cursor", 0);
    let limit = number(args, "limit", 10).clamp(1, 20);
    let mut result = page(scope);
    let mut next = offset;
    for chat in chats.iter().skip(offset).take(limit) {
        if !push_fits(&mut result, metadata(chat, None), budget) {
            break;
        }
        next += 1;
    }
    if next < chats.len() {
        result["next_cursor"] = json!(next);
    }
    result
}

fn search(chats: &[&Value], args: &Value, budget: usize, scope: &str) -> Result<Value, String> {
    let query = args["query"]
        .as_str()
        .map(str::trim)
        .filter(|q| !q.is_empty() && q.len() <= 500)
        .ok_or("search_chats requires a query of 1–500 bytes.")?
        .to_lowercase();
    let terms: Vec<&str> = query.split_whitespace().collect();
    let mut hits = Vec::new();
    for (order, chat) in chats.iter().enumerate() {
        let title = chat["title"].as_str().unwrap_or("").to_lowercase();
        for (index, message) in chat["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
        {
            let Some(text) = visible_text(message) else {
                continue;
            };
            let lower = text.to_lowercase();
            if !terms
                .iter()
                .all(|term| title.contains(term) || lower.contains(term))
            {
                continue;
            }
            let score = usize::from(lower.contains(&query)) * 4
                + terms.iter().filter(|term| lower.contains(**term)).count();
            hits.push((std::cmp::Reverse(score), order, index, message, *chat, text));
        }
    }
    hits.sort_by_key(|hit| (hit.0, hit.1, hit.2));
    let offset = number(args, "cursor", 0);
    let limit = number(args, "limit", 5).clamp(1, 20);
    let mut result = page(scope);
    let mut next = offset;
    for (_, _, index, message, chat, text) in hits.iter().skip(offset).take(limit) {
        let mut item = metadata(chat, Some(*index));
        item["role"] = message["role"].clone();
        item["excerpt"] = json!("");
        let capacity = text_capacity(&result, &item, budget, 600);
        if capacity < 32 && !result["results"].as_array().unwrap().is_empty() {
            break;
        }
        // Center the bounded excerpt on a hit, including Unicode text safely.
        let lower = text.to_lowercase();
        let start = terms
            .iter()
            .filter_map(|term| lower.find(term))
            .min()
            .unwrap_or(0);
        let char_start = lower[..start].chars().count().saturating_sub(80);
        let excerpt: String = text.chars().skip(char_start).take(capacity).collect();
        item["excerpt"] = json!(excerpt);
        if !push_fits(&mut result, item, budget) {
            break;
        }
        next += 1;
    }
    if next < hits.len() {
        result["next_cursor"] = json!(next);
    }
    Ok(result)
}

fn read(chats: &[&Value], args: &Value, budget: usize, scope: &str) -> Result<Value, String> {
    let id = args["chat_id"]
        .as_str()
        .ok_or("read_chat requires chat_id.")?;
    let chat = chats
        .iter()
        .find(|chat| chat["id"].as_str() == Some(id))
        .ok_or("Chat is unavailable in the current retrieval scope.")?;
    let messages = chat["messages"].as_array().ok_or("Chat has no messages.")?;
    let cursor = number(args, "cursor", 0);
    let mut char_offset = number(args, "char_offset", 0);
    let limit = number(args, "limit", 5).clamp(1, 20);
    let mut result = page(scope);
    for (index, message) in messages.iter().enumerate().skip(cursor) {
        let Some(text) = visible_text(message) else {
            char_offset = 0;
            continue;
        };
        let count = text.chars().count();
        if char_offset >= count {
            char_offset = 0;
            continue;
        }
        let mut item = metadata(chat, Some(index));
        item["role"] = message["role"].clone();
        item["char_offset"] = json!(char_offset);
        item["content"] = json!("");
        item["truncated"] = json!(false);
        let capacity = text_capacity(&result, &item, budget, 1600);
        if capacity == 0 {
            result["next_cursor"] = json!(index);
            result["next_char_offset"] = json!(char_offset);
            return Ok(result);
        }
        let content: String = text.chars().skip(char_offset).take(capacity).collect();
        let end = char_offset + content.chars().count();
        item["content"] = json!(content);
        item["truncated"] = json!(end < count);
        if !push_fits(&mut result, item, budget) {
            result["next_cursor"] = json!(index);
            result["next_char_offset"] = json!(char_offset);
            return Ok(result);
        }
        if end < count {
            result["next_cursor"] = json!(index);
            result["next_char_offset"] = json!(end);
            return Ok(result);
        }
        char_offset = 0;
        if result["results"].as_array().unwrap().len() >= limit {
            if index + 1 < messages.len() {
                result["next_cursor"] = json!(index + 1);
            }
            break;
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{app::App, config::Config};
    use std::sync::Mutex;

    fn fixture() -> (tempfile::TempDir, SharedApp) {
        let dir = tempfile::tempdir().unwrap();
        let app = App::new(Config::default(), dir.path().join("config.toml")).unwrap();
        app.save_chat_store(json!({"activeProfileId":"work", "profiles":[
            {"id":"work", "conversations":[
                {"id":"current","projectId":"p","messages":[]},
                {"id":"past","title":"Authentication","projectId":"p","updatedAt":10,"messages":[
                    {"role":"system","content":"secret system instructions"},
                    {"role":"assistant","content":"<think>private reasoning</think>We chose Clerk.<memory_update>private memory</memory_update>"}
                ]},
                {"id":"other-project","projectId":"q","messages":[{"role":"user","content":"Clerk"}]},
                {"id":"ghost","projectId":"p","incognito":true,"messages":[{"role":"user","content":"Clerk"}]},
                {"id":"plain","messages":[]},
                {"id":"plain-past","messages":[{"role":"user","content":"Clerk"}]}
            ]},
            {"id":"personal","conversations":[{"id":"private","projectId":"p","messages":[{"role":"user","content":"Clerk"}]}]}
        ]})).unwrap();
        (dir, Arc::new(Mutex::new(app)))
    }

    #[test]
    fn retrieves_only_visible_messages_in_current_scope() {
        let (_dir, app) = fixture();
        let history = ChatHistory::open(app.clone(), "current").unwrap();
        let result: Value = serde_json::from_str(
            &history
                .execute("search_chats", &json!({"query":"Clerk"}), 12000)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(result["results"].as_array().unwrap().len(), 1);
        assert_eq!(result["results"][0]["chat_id"], "past");
        assert_eq!(result["results"][0]["message_index"], 1);
        assert_eq!(result["results"][0]["excerpt"], "We chose Clerk.");
        assert!(
            history
                .execute("read_chat", &json!({"chat_id":"private"}), 12000)
                .is_err()
        );
        assert!(
            history
                .execute("read_chat", &json!({"chat_id":"ghost"}), 12000)
                .is_err()
        );
        assert!(ChatHistory::open(app.clone(), "ghost").is_none());
        assert!(ChatHistory::open(app.clone(), "missing").is_none());
        let plain = ChatHistory::open(app, "plain").unwrap();
        let result: Value =
            serde_json::from_str(&plain.execute("list_chats", &json!({}), 12000).unwrap()).unwrap();
        assert_eq!(result["results"][0]["chat_id"], "plain-past");
        assert_eq!(result["results"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn hidden_nested_malformed_and_non_text_content_never_enters_results() {
        for content in [
            "Visible<think>secret<memory_update>secret</memory_update>secret</think> answer",
            "Visible<think>secret</analysis>secret",
            "Visible[[memory_update]]secret[[bot_memory_update]]secret[[/bot_memory_update]]secret[[/memory_update]] answer",
            "Visible<THINK>secret<think>secret</think>secret</THINK> answer",
        ] {
            let text = visible_text(&json!({"role":"assistant", "content":content})).unwrap();
            assert!(!text.contains("secret"), "{text}");
            assert!(text.starts_with("Visible"));
        }
        assert_eq!(
            visible_text(&json!({"role":"tool", "content":"secret"})),
            None
        );
        assert_eq!(
            visible_text(&json!({"role":"assistant", "content":[
            {"type":"thinking", "thinking":"secret"},
            {"type":"image_url", "image_url":{"url":"secret"}},
            {"type":"text", "text":"Visible"}
        ], "reasoning":"secret", "attachments":[{"text":"secret"}]})),
            Some("Visible".into())
        );
    }

    #[test]
    fn switch_deletion_and_lock_revoke_existing_access() {
        let (_dir, app) = fixture();
        let history = ChatHistory::open(app.clone(), "current").unwrap();
        app.lock()
            .unwrap()
            .save_chat_preferences(json!({"chatRetrieval":false}))
            .unwrap();
        assert!(history.execute("list_chats", &json!({}), 12000).is_err());
        assert!(ChatHistory::open(app.clone(), "current").is_none());
        app.lock()
            .unwrap()
            .save_chat_preferences(json!({}))
            .unwrap();
        let mut store = app.lock().unwrap().load_chat_store().unwrap();
        store["activeProfileId"] = json!("personal");
        app.lock().unwrap().save_chat_store(store.clone()).unwrap();
        assert!(history.execute("list_chats", &json!({}), 12000).is_err());
        store["activeProfileId"] = json!("work");
        store["profiles"][0]["conversations"]
            .as_array_mut()
            .unwrap()
            .retain(|chat| chat["id"] != "past");
        app.lock().unwrap().save_chat_store(store).unwrap();
        assert!(
            history
                .execute("read_chat", &json!({"chat_id":"past"}), 12000)
                .is_err()
        );
        app.lock()
            .unwrap()
            .enable_disk_encryption("testing passphrase", "testing passphrase")
            .unwrap();
        app.lock().unwrap().lock_disk_encryption();
        assert!(history.execute("list_chats", &json!({}), 12000).is_err());
    }

    #[test]
    fn unicode_pages_resume_without_losing_text_and_stay_bounded() {
        let text = "界🙂\n\"".repeat(1000);
        let chat = json!({"id":"encoded /?","title":"Long chat","messages":[{"role":"user","content":text}]});
        let mut args = json!({"chat_id":"encoded /?"});
        let mut collected = String::new();
        loop {
            let result = read(&[&chat], &args, 1024, "test").unwrap();
            assert!(result.to_string().len() <= 1024);
            collected.push_str(result["results"][0]["content"].as_str().unwrap());
            if result["next_cursor"].is_null() {
                break;
            }
            args["cursor"] = result["next_cursor"].clone();
            args["char_offset"] = result["next_char_offset"].clone();
        }
        assert_eq!(collected, text);
        assert_eq!(
            metadata(&chat, Some(0))["url"],
            "/c/encoded%20%2F%3F?message=0"
        );
        assert!(
            search(&[&chat], &json!({"query":"界"}), 1024, "test")
                .unwrap()
                .to_string()
                .len()
                <= 1024
        );
    }

    #[test]
    fn tools_require_a_server_bound_scope_and_do_not_require_per_read_approval() {
        use crate::agent::{
            AgentSkills, ApprovalMode, capability_allowed, needs_approval, openai_tools_payload,
        };
        let (_dir, app) = fixture();
        let mut skills: AgentSkills = serde_json::from_value(json!({
            "chat_history": {"profile_id":"personal", "conversation_id":"private"}
        }))
        .unwrap();
        assert!(skills.chat_retrieval);
        assert!(skills.chat_history.is_none());
        for name in ["list_chats", "search_chats", "read_chat"] {
            assert!(!capability_allowed(name, &skills, &[]));
            assert!(
                !openai_tools_payload(&skills, &[], false)
                    .iter()
                    .any(|tool| tool["function"]["name"] == name)
            );
        }
        skills.chat_history = ChatHistory::open(app, "current");
        assert!(skills.any_enabled());
        let tools = openai_tools_payload(&skills, &[], false);
        for name in ["list_chats", "search_chats", "read_chat"] {
            assert!(capability_allowed(name, &skills, &[]));
            assert!(tools.iter().any(|tool| tool["function"]["name"] == name));
            assert!(!needs_approval(name, ApprovalMode::Manual));
        }
    }

    #[test]
    fn lists_and_searches_page_without_repeating_or_skipping_hits() {
        let values: Vec<Value> = (0..12).map(|i| json!({
            "id": format!("chat-{i}"), "title": "Plan", "messages": [{"role":"user","content":"Clerk decision"}]
        })).collect();
        let chats: Vec<&Value> = values.iter().collect();
        for searching in [false, true] {
            let mut args = json!({"query":"Clerk", "limit":3});
            let mut ids = Vec::new();
            loop {
                let result = if searching {
                    search(&chats, &args, 1024, "test").unwrap()
                } else {
                    list(&chats, &args, 1024, "test")
                };
                assert!(result.to_string().len() <= 1024);
                for item in result["results"].as_array().unwrap() {
                    ids.push(item["chat_id"].as_str().unwrap().to_owned());
                }
                if result["next_cursor"].is_null() {
                    break;
                }
                let next = result["next_cursor"].as_u64().unwrap();
                assert!(next > args["cursor"].as_u64().unwrap_or(0));
                args["cursor"] = json!(next);
            }
            assert_eq!(
                ids,
                (0..12).map(|i| format!("chat-{i}")).collect::<Vec<_>>()
            );
        }
    }

    #[tokio::test]
    async fn tool_loop_returns_visible_sources_for_both_provider_styles() {
        use crate::{
            agent::{AgentRequest, stream_agent},
            providers::{ApiStyle, ProviderKind},
            subscription::PreparedUpstream,
        };
        use axum::{Json, Router, extract::State, routing::post};
        use futures_util::StreamExt;

        let _ = rustls::crypto::ring::default_provider().install_default();

        #[derive(Clone)]
        struct Mock {
            style: ApiStyle,
            calls: Arc<Mutex<Vec<Value>>>,
        }
        async fn reply(
            State(mock): State<Mock>,
            Json(body): Json<Value>,
        ) -> ([(&'static str, &'static str); 1], String) {
            let round = {
                let mut calls = mock.calls.lock().unwrap();
                calls.push(body);
                calls.len()
            };
            let tool = match round {
                1 => Some(("search_chats", json!({"query":"Clerk"}))),
                2 => Some(("read_chat", json!({"chat_id":"past", "cursor":1}))),
                _ => None,
            };
            let answer = "We chose Clerk. [Authentication](/c/past?message=1)";
            let data = if mock.style == ApiStyle::Openai {
                let delta = if let Some((name, args)) = tool {
                    json!({"tool_calls":[{"index":0,"id":format!("call_{round}"),"type":"function","function":{"name":name,"arguments":args.to_string()}}]})
                } else {
                    json!({"content":answer})
                };
                format!(
                    "data: {}\n\ndata: [DONE]\n\n",
                    json!({"choices":[{"index":0,"delta":delta}]})
                )
            } else {
                let (block, delta, stop) = if let Some((name, args)) = tool {
                    (
                        json!({"type":"tool_use","id":format!("call_{round}"),"name":name,"input":{}}),
                        json!({"type":"input_json_delta","partial_json":args.to_string()}),
                        "tool_use",
                    )
                } else {
                    (
                        json!({"type":"text","text":""}),
                        json!({"type":"text_delta","text":answer}),
                        "end_turn",
                    )
                };
                [
                    ("message_start", json!({"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"test","content":[],"usage":{"input_tokens":1,"output_tokens":0}}})),
                    ("content_block_start", json!({"type":"content_block_start","index":0,"content_block":block})),
                    ("content_block_delta", json!({"type":"content_block_delta","index":0,"delta":delta})),
                    ("content_block_stop", json!({"type":"content_block_stop","index":0})),
                    ("message_delta", json!({"type":"message_delta","delta":{"stop_reason":stop},"usage":{"output_tokens":10}})),
                    ("message_stop", json!({"type":"message_stop"})),
                ].into_iter().map(|(event, value)| format!("event: {event}\ndata: {value}\n\n")).collect()
            };
            ([("content-type", "text/event-stream")], data)
        }

        for style in [ApiStyle::Openai, ApiStyle::Anthropic] {
            let (_dir, app) = fixture();
            let calls = Arc::new(Mutex::new(Vec::new()));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let router = Router::new()
                .route("/v1/chat/completions", post(reply))
                .route("/v1/messages", post(reply))
                .with_state(Mock {
                    style,
                    calls: calls.clone(),
                });
            let server = tokio::spawn(async move {
                axum::serve(listener, router).await.unwrap();
            });
            let mut request: AgentRequest = serde_json::from_value(json!({
                "agent":true, "messages":[{"role":"user","content":"What did we decide about authentication?"}]
            })).unwrap();
            request.skills.chat_history = ChatHistory::open(app, "current");
            let upstream = PreparedUpstream {
                api_base: format!("http://{address}/v1"),
                token: "test".into(),
                style,
                allow_insecure_tls: false,
                extra_headers: vec![],
                no_redirect: false,
                kind: ProviderKind::Custom,
                wire_model: "test".into(),
            };
            let outcome = tokio::time::timeout(std::time::Duration::from_secs(10), async {
                let mut stream = stream_agent(upstream, request, vec![]);
                let mut output = String::new();
                while let Some(chunk) = stream.next().await {
                    output.push_str(&String::from_utf8(chunk.unwrap()).unwrap());
                }
                output
            })
            .await;
            server.abort();
            let output = outcome.expect("retrieval loop must complete without a read approval");
            assert!(output.contains("Past-chat retrieval enabled"), "{output}");
            assert!(
                output.contains("search_chats") && output.contains("read_chat"),
                "{output}"
            );
            assert!(output.contains("/c/past?message=1"), "{output}");
            assert!(!output.contains("private reasoning") && !output.contains("private memory"));
            let calls = calls.lock().unwrap();
            assert_eq!(calls.len(), 3, "{output}");
            assert!(calls[0]["tools"].to_string().contains("search_chats"));
            assert!(calls[1]["messages"].to_string().contains("We chose Clerk."));
            assert!(
                calls[2]["messages"]
                    .to_string()
                    .contains("/c/past?message=1")
            );
        }
    }
}
