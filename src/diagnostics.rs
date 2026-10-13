//! Opt-in, bounded diagnostics. Producers only enqueue; disk writes are batched.
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroize;

pub const MAX_ENTRIES: usize = 2_000;
pub const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_ENTRY_BYTES: usize = 128 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub id: u64,
    pub timestamp: u64,
    pub level: String,
    pub source: String,
    pub event: String,
    pub trace_id: String,
    pub conversation_id: String,
    pub elapsed_ms: Option<f64>,
    pub data: String,
    #[serde(default)]
    pub truncated_bytes: usize,
}

impl Drop for Entry {
    fn drop(&mut self) {
        self.data.zeroize();
        self.trace_id.zeroize();
        self.conversation_id.zeroize();
    }
}

#[derive(Debug, Deserialize)]
pub struct Input {
    #[serde(default)]
    pub timestamp: Option<u64>,
    #[serde(default)]
    pub level: String,
    #[serde(default)]
    pub event: String,
    #[serde(default)]
    pub trace_id: String,
    #[serde(default)]
    pub conversation_id: String,
    #[serde(default)]
    pub elapsed_ms: Option<f64>,
    #[serde(default)]
    pub data: Value,
}

#[derive(Debug, Default)]
struct Buffer {
    entries: VecDeque<Entry>,
    timings: VecDeque<Entry>,
    bytes: usize,
    next_id: u64,
    revision: u64,
    saved_revision: u64,
    dropped: u64,
    error: String,
    restore_failed: bool,
}

#[derive(Debug, Default)]
pub struct Diagnostics {
    enabled: AtomicBool,
    generation: AtomicU64,
    buffer: Mutex<Buffer>,
}

impl Diagnostics {
    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }
    pub fn configure(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::SeqCst);
    }

    pub fn push(&self, source: &str, input: Input) {
        self.push_scoped(source, input, None);
    }

    fn push_scoped(&self, source: &str, input: Input, generation: Option<u64>) {
        if !self.enabled() || generation.is_some_and(|generation| generation != self.generation()) {
            return;
        }
        let mut data = input.data;
        redact_value(&mut data);
        let mut data = serde_json::to_string_pretty(&data).unwrap_or_default();
        let original_bytes = data.len();
        if data.len() > MAX_ENTRY_BYTES {
            let mut end = MAX_ENTRY_BYTES;
            while !data.is_char_boundary(end) {
                end -= 1;
            }
            data.truncate(end);
            data.push_str("\n[Entry truncated; original byte count recorded]");
        }
        let Ok(mut buffer) = self.buffer.lock() else {
            return;
        };
        // Lock may have revoked capture while this producer was formatting.
        if !self.enabled() || generation.is_some_and(|generation| generation != self.generation()) {
            data.zeroize();
            return;
        }
        buffer.next_id += 1;
        let entry = Entry {
            id: buffer.next_id,
            timestamp: input.timestamp.unwrap_or_else(now_ms),
            level: match input.level.to_lowercase().as_str() {
                "error" => "error",
                "warn" | "warning" => "warn",
                "trace" => "trace",
                "debug" => "debug",
                _ => "info",
            }
            .into(),
            source: source.chars().take(80).collect(),
            event: input.event.chars().take(160).collect(),
            trace_id: input.trace_id.chars().take(128).collect(),
            conversation_id: input.conversation_id.chars().take(128).collect(),
            elapsed_ms: input.elapsed_ms.filter(|ms| ms.is_finite() && *ms >= 0.0),
            truncated_bytes: original_bytes.saturating_sub(MAX_ENTRY_BYTES),
            data,
        };
        buffer.bytes += entry_size(&entry);
        if timing_event(&entry.event)
            && !entry.trace_id.is_empty()
            && !buffer
                .timings
                .iter()
                .any(|item| item.trace_id == entry.trace_id && item.event == entry.event)
        {
            let mut timing = entry.clone();
            timing.data = "{}".into();
            timing.truncated_bytes = 0;
            buffer.timings.push_back(timing);
            if buffer.timings.len() > 256 {
                buffer.timings.pop_front();
            }
        }
        buffer.entries.push_back(entry);
        prune(&mut buffer);
        buffer.revision += 1;
    }

    pub fn view(&self, after: u64) -> Value {
        let buffer = self
            .buffer
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        json!({
            "enabled": self.enabled(), "generation": self.generation(),
            "entries": buffer.entries.iter().filter(|entry| entry.id > after).collect::<Vec<_>>(),
            "last_id": buffer.next_id, "oldest_id": buffer.entries.front().map(|entry| entry.id),
            "dropped": buffer.dropped, "bytes": buffer.bytes, "error": buffer.error,
            "timings": buffer.timings,
            "max_entries": MAX_ENTRIES, "max_bytes": MAX_BYTES,
        })
    }

    pub fn stored(&self) -> Value {
        let buffer = self
            .buffer
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        json!({ "version": 1, "entries": buffer.entries, "timings": buffer.timings, "last_id": buffer.next_id, "dropped": buffer.dropped })
    }

    pub fn restore(&self, value: Value) -> Result<(), String> {
        if value.is_null() {
            return Ok(());
        }
        let entries = value.get("entries").cloned().unwrap_or(json!([]));
        let entries: VecDeque<Entry> = serde_json::from_value(entries)
            .map_err(|error| format!("Could not read diagnostics: {error}"))?;
        let mut buffer = self
            .buffer
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        buffer.entries = entries;
        buffer.timings = serde_json::from_value(value.get("timings").cloned().unwrap_or(json!([])))
            .map_err(|error| error.to_string())?;
        while buffer.timings.len() > 256 {
            buffer.timings.pop_front();
        }
        buffer.next_id = value["last_id"].as_u64().unwrap_or_default().max(
            buffer
                .entries
                .iter()
                .map(|entry| entry.id)
                .max()
                .unwrap_or_default(),
        );
        buffer.bytes = buffer.entries.iter().map(entry_size).sum();
        buffer.dropped = value["dropped"].as_u64().unwrap_or_default();
        buffer.error.clear();
        buffer.restore_failed = false;
        prune(&mut buffer);
        buffer.revision += 1;
        buffer.saved_revision = buffer.revision;
        self.generation.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    pub fn pending(&self) -> Option<(u64, Value)> {
        let buffer = self.buffer.lock().ok()?;
        if buffer.restore_failed || buffer.revision == buffer.saved_revision {
            return None;
        }
        Some((
            buffer.revision,
            json!({ "version": 1, "entries": buffer.entries, "timings": buffer.timings, "last_id": buffer.next_id, "dropped": buffer.dropped }),
        ))
    }

    pub fn saved(&self, revision: u64) {
        if let Ok(mut buffer) = self.buffer.lock() {
            buffer.saved_revision = revision;
            buffer.error.clear();
        }
    }
    pub fn error(&self, error: String) {
        if let Ok(mut buffer) = self.buffer.lock() {
            buffer.error = error;
        }
    }
    pub fn restore_error(&self, error: String) {
        if let Ok(mut buffer) = self.buffer.lock() {
            buffer.error = error;
            buffer.restore_failed = true;
        }
    }

    pub fn clear(&self) {
        let mut buffer = self
            .buffer
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        buffer.entries.clear();
        buffer.timings.clear();
        buffer.bytes = 0;
        buffer.dropped = 0;
        buffer.error.clear();
        buffer.restore_failed = false;
        buffer.revision += 1;
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
    pub fn suspend(&self) {
        self.configure(false);
        self.clear();
    }
}

fn timing_event(event: &str) -> bool {
    event.starts_with("prompt.prepare.")
        || event.starts_with("cancel.wait.")
        || event.starts_with("store.wait.")
        || event.starts_with("provider.prepare.")
        || event.starts_with("server.first_")
        || event.starts_with("browser.first_")
        || matches!(
            event,
            "turn.started"
                | "chat.received"
                | "chat.request.dispatch"
                | "provider.request"
                | "provider.headers"
                | "provider.first_byte"
                | "stream.finished"
                | "stream.cancelled"
        )
}

fn entry_size(entry: &Entry) -> usize {
    entry.data.len() + entry.event.len() + entry.trace_id.len() + entry.conversation_id.len() + 256
}
fn prune(buffer: &mut Buffer) {
    while buffer.entries.len() > MAX_ENTRIES || buffer.bytes > MAX_BYTES {
        if let Some(entry) = buffer.entries.pop_front() {
            buffer.bytes = buffer.bytes.saturating_sub(entry_size(&entry));
            buffer.dropped += 1;
        } else {
            break;
        }
    }
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase().replace('-', "_");
    matches!(
        key.as_str(),
        "authorization"
            | "token"
            | "access_token"
            | "refresh_token"
            | "id_token"
            | "password"
            | "passphrase"
            | "passphrase_confirm"
            | "cookie"
            | "set_cookie"
            | "secret"
            | "api_key"
            | "x_api_key"
    ) || key.ends_with("api_key")
        || key.ends_with("apikey")
        || key.ends_with("secret")
}
pub fn redact_value(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            for (key, value) in fields {
                if secret_key(key) {
                    *value = json!("[redacted]");
                } else {
                    redact_value(value);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                redact_value(value);
            }
        }
        Value::String(value) => *value = redact_text(value),
        _ => {}
    }
}
fn redact_text(value: &str) -> String {
    static BEARER: OnceLock<regex::Regex> = OnceLock::new();
    let value = BEARER
        .get_or_init(|| {
            regex::Regex::new(r#"(?i)(?:bearer|basic)\s+[^\s\"',]+"#)
                .expect("bearer redaction regex")
        })
        .replace_all(value, "Bearer [redacted]");
    static SECRETS: OnceLock<regex::Regex> = OnceLock::new();
    let regex = SECRETS.get_or_init(|| regex::Regex::new(
        r#"(?i)(bearer\s+)[^\s\"',]+|((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passphrase|token|cookie|gopher_session)[\"']?\s*[:=]\s*[\"']?)[^\s\"',&}\r\n]+"#
    ).expect("diagnostic redaction regex"));
    regex
        .replace_all(&value, |caps: &regex::Captures<'_>| {
            format!(
                "{}[redacted]",
                caps.get(1)
                    .or_else(|| caps.get(2))
                    .map(|value| value.as_str())
                    .unwrap_or_default()
            )
        })
        .into_owned()
}

#[derive(Clone)]
pub struct Trace {
    pub hub: Arc<Diagnostics>,
    pub id: String,
    pub conversation_id: String,
    started: Instant,
    generation: u64,
    upstream: Arc<Mutex<Option<(Instant, bool)>>>,
}
tokio::task_local! { pub static CURRENT: Trace; }
impl Trace {
    pub fn new(hub: Arc<Diagnostics>, id: String, conversation_id: String) -> Self {
        let generation = hub.generation();
        Self {
            hub,
            id,
            conversation_id,
            started: Instant::now(),
            generation,
            upstream: Arc::new(Mutex::new(None)),
        }
    }
    pub fn record(&self, event: &str, data: Value) {
        if self.generation != self.hub.generation() {
            return;
        }
        self.hub.push_scoped(
            "server",
            Input {
                timestamp: None,
                level: if event.contains("error") || event.ends_with("stalled") {
                    "error"
                } else {
                    "debug"
                }
                .into(),
                event: event.into(),
                trace_id: self.id.clone(),
                conversation_id: self.conversation_id.clone(),
                elapsed_ms: Some(self.started.elapsed().as_secs_f64() * 1000.0),
                data,
            },
            Some(self.generation),
        );
    }
}
pub fn record(event: &str, data: impl FnOnce() -> Value) {
    let _ = CURRENT.try_with(|trace| {
        if trace.hub.enabled() {
            trace.record(event, data());
        }
    });
}
pub fn upstream_started(url: &str, payload: &Value) {
    let _ = CURRENT.try_with(|trace| {
        if !trace.hub.enabled() {
            return;
        }
        if let Ok(mut upstream) = trace.upstream.lock() {
            *upstream = Some((Instant::now(), false));
        }
        trace.record("provider.request", json!({ "url": url, "body": payload }));
    });
}
pub fn upstream_chunk(bytes: &[u8]) {
    let _ = CURRENT.try_with(|trace| {
        if !trace.hub.enabled() { return; }
        if let Ok(mut upstream) = trace.upstream.lock()
            && let Some((started, seen)) = upstream.as_mut() && !*seen {
                *seen = true;
                trace.record("provider.first_byte", json!({ "request_elapsed_ms": started.elapsed().as_secs_f64() * 1000.0, "bytes": bytes.len() }));
        }
        trace.record("provider.raw_chunk", json!({ "bytes": bytes.len(), "text": String::from_utf8_lossy(bytes) }));
    });
}

struct EndGuard {
    trace: Trace,
    completed: bool,
}
impl Drop for EndGuard {
    fn drop(&mut self) {
        self.trace.record(
            if self.completed {
                "stream.finished"
            } else {
                "stream.cancelled"
            },
            json!({}),
        );
    }
}
pub fn trace_stream(
    mut stream: crate::agent::chat::ChatStream,
    trace: Trace,
) -> crate::agent::chat::ChatStream {
    Box::pin(async_stream::stream! {
        let mut guard = EndGuard { trace: trace.clone(), completed: false };
        let mut first_reasoning = false;
        let mut first_answer = false;
        let mut first_tool = false;
        let mut buffer = Vec::new();
        while let Some(frame) = CURRENT.scope(trace.clone(), stream.next()).await {
            if trace.hub.enabled() {
                match &frame {
                    Ok(bytes) => {
                        let text = String::from_utf8_lossy(bytes);
                        trace.record("stream.frame", json!({ "text": text }));
                        buffer.extend_from_slice(bytes);
                        let mut consumed = 0;
                        while let Some(offset) = buffer[consumed..].iter().position(|byte| *byte == b'\n') {
                            let end = consumed + offset;
                            let line = &buffer[consumed..end];
                            consumed = end + 1;
                            let Some(data) = line.strip_prefix(b"data:") else { continue; };
                            if let Ok(value) = serde_json::from_slice::<Value>(data) {
                                if value.get("error").is_some() { trace.record("provider.error", value.clone()); }
                                let delta = &value["choices"][0]["delta"];
                                if !first_reasoning && ["reasoning", "reasoning_content"].iter().any(|key| delta[key].as_str().is_some_and(|value| !value.is_empty())) {
                                    first_reasoning = true;
                                    trace.record("server.first_reasoning_token", json!({}));
                                }
                                if !first_answer && delta["content"].as_str().is_some_and(|value| !value.is_empty()) {
                                    first_answer = true;
                                    trace.record("server.first_content_token", json!({}));
                                }
                                if !first_tool && (delta["tool_calls"].as_array().is_some_and(|calls| !calls.is_empty()) || matches!(value["phase"].as_str(), Some("tool_prepare" | "tool_call"))) {
                                    first_tool = true;
                                    trace.record("server.first_tool_token", json!({}));
                                }
                                if let Some(phase) = value["phase"].as_str() { trace.record(&format!("agent.{phase}"), value); }
                            }
                        }
                        if consumed > 0 { buffer.drain(..consumed); }
                        if buffer.len() > 1024 * 1024 { buffer.clear(); trace.record("diagnostics.parse_limit", json!({})); }
                    },
                    Err(error) => trace.record("stream.error", json!({ "error": error.to_string() })),
                }
            }
            yield frame;
        }
        guard.completed = true;
    })
}

static GLOBAL: OnceLock<Mutex<Weak<Diagnostics>>> = OnceLock::new();
fn global() -> Option<Arc<Diagnostics>> {
    GLOBAL.get()?.lock().ok()?.upgrade()
}
struct Logger;
impl log::Log for Logger {
    fn enabled(&self, _: &log::Metadata<'_>) -> bool {
        global().is_some_and(|hub| hub.enabled())
    }
    fn log(&self, record: &log::Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        if let Some(hub) = global() {
            if CURRENT
                .try_with(|trace| trace.generation != hub.generation())
                .unwrap_or(false)
            {
                return;
            }
            let (trace_id, conversation_id, elapsed_ms) = CURRENT
                .try_with(|trace| {
                    (
                        trace.id.clone(),
                        trace.conversation_id.clone(),
                        Some(trace.started.elapsed().as_secs_f64() * 1000.0),
                    )
                })
                .unwrap_or_default();
            hub.push_scoped(record.target(), Input { timestamp: None, level: record.level().as_str().into(),
                event: "application.log".into(), trace_id, conversation_id, elapsed_ms,
                data: json!({ "message": record.args().to_string(), "file": record.file(), "line": record.line() }) }, CURRENT.try_with(|trace| trace.generation).ok());
        }
    }
    fn flush(&self) {}
}

struct NativeSubscriber;
impl tracing::Subscriber for NativeSubscriber {
    fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
        global().is_some_and(|hub| hub.enabled())
    }
    fn register_callsite(
        &self,
        _: &'static tracing::Metadata<'static>,
    ) -> tracing::subscriber::Interest {
        tracing::subscriber::Interest::sometimes()
    }
    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        tracing::span::Id::from_u64(NEXT.fetch_add(1, Ordering::Relaxed))
    }
    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn event(&self, event: &tracing::Event<'_>) {
        struct Fields(serde_json::Map<String, Value>);
        impl tracing::field::Visit for Fields {
            fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
                self.0
                    .insert(field.name().into(), json!(format!("{value:?}")));
            }
            fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
                self.0.insert(field.name().into(), json!(value));
            }
        }
        let Some(hub) = global().filter(|hub| hub.enabled()) else {
            return;
        };
        if CURRENT
            .try_with(|trace| trace.generation != hub.generation())
            .unwrap_or(false)
        {
            return;
        }
        // Transport traces outside an application request include the diagnostics
        // polling connection itself. Do not recursively log the log transport.
        if CURRENT.try_with(|_| ()).is_err()
            && matches!(
                *event.metadata().level(),
                tracing::Level::DEBUG | tracing::Level::TRACE
            )
        {
            return;
        }
        let mut fields = Fields(serde_json::Map::new());
        event.record(&mut fields);
        let (trace_id, conversation_id, elapsed_ms) = CURRENT
            .try_with(|trace| {
                (
                    trace.id.clone(),
                    trace.conversation_id.clone(),
                    Some(trace.started.elapsed().as_secs_f64() * 1000.0),
                )
            })
            .unwrap_or_default();
        hub.push_scoped(
            event.metadata().target(),
            Input {
                timestamp: None,
                level: event.metadata().level().as_str().into(),
                event: "application.trace".into(),
                trace_id,
                conversation_id,
                elapsed_ms,
                data: Value::Object(fields.0),
            },
            CURRENT.try_with(|trace| trace.generation).ok(),
        );
    }
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
    fn max_level_hint(&self) -> Option<tracing::metadata::LevelFilter> {
        Some(tracing::metadata::LevelFilter::TRACE)
    }
}
pub fn install(hub: &Arc<Diagnostics>) {
    *GLOBAL
        .get_or_init(|| Mutex::new(Weak::new()))
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Arc::downgrade(hub);
    static LOGGER: Logger = Logger;
    static INIT: OnceLock<()> = OnceLock::new();
    INIT.get_or_init(|| {
        let _ = log::set_logger(&LOGGER);
        log::set_max_level(log::LevelFilter::Trace);
        let _ = tracing::subscriber::set_global_default(NativeSubscriber);
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            log::error!("{info}");
            previous(info);
        }));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(data: Value) -> Input {
        Input {
            timestamp: None,
            level: "info".into(),
            event: "test".into(),
            trace_id: String::new(),
            conversation_id: String::new(),
            elapsed_ms: None,
            data,
        }
    }
    #[test]
    fn capture_is_disabled_by_default_and_revocation_clears_memory() {
        let hub = Diagnostics::default();
        hub.push("test", input(json!("secret prompt")));
        assert_eq!(hub.view(0)["entries"].as_array().unwrap().len(), 0);
        hub.configure(true);
        hub.push("test", input(json!("prompt")));
        assert_eq!(hub.view(0)["entries"].as_array().unwrap().len(), 1);
        hub.suspend();
        assert!(!hub.enabled());
        assert_eq!(hub.view(0)["entries"].as_array().unwrap().len(), 0);
    }
    #[test]
    fn capture_redacts_nested_credentials_and_raw_wire_headers() {
        let hub = Diagnostics::default();
        hub.configure(true);
        hub.push("test", input(json!({ "api_key": "sensitive", "skills": { "webSearchParallelApiKey": "sensitive" }, "wire": "Authorization: Bearer abc123\napi_key=secret", "prompt": "regular text" })));
        let text = hub.stored().to_string();
        assert!(!text.contains("sensitive"));
        assert!(!text.contains("abc123"));
        assert!(!text.contains("secret"));
        assert!(text.contains("regular text"));
        assert!(text.contains("[redacted]"));
    }
    #[test]
    fn buffer_bounds_and_cursor_survive_clear_and_reload() {
        let hub = Diagnostics::default();
        hub.configure(true);
        for _ in 0..MAX_ENTRIES + 10 {
            hub.push("test", input(json!({})));
        }
        assert_eq!(
            hub.view(0)["entries"].as_array().unwrap().len(),
            MAX_ENTRIES
        );
        assert_eq!(hub.view(0)["dropped"], 10);
        let restored = Diagnostics::default();
        restored.restore(hub.stored()).unwrap();
        assert_eq!(restored.view(0)["last_id"], hub.view(0)["last_id"]);
        let last = hub.view(0)["last_id"].as_u64().unwrap();
        hub.clear();
        hub.push("test", input(json!({})));
        assert_eq!(hub.view(last)["entries"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn first_token_timings_survive_rotation_of_raw_chunks() {
        let hub = Arc::new(Diagnostics::default());
        hub.configure(true);
        let trace = Trace::new(hub.clone(), "turn".into(), "chat".into());
        trace.record("provider.first_byte", json!({}));
        for _ in 0..MAX_ENTRIES + 1 {
            trace.record("provider.raw_chunk", json!({"text": "output"}));
        }
        assert!(
            !hub.view(0)["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["event"] == "provider.first_byte")
        );
        assert_eq!(hub.view(0)["timings"][0]["event"], "provider.first_byte");
    }

    #[tokio::test]
    async fn token_observation_handles_fragmented_unicode_without_changing_output() {
        let hub = Arc::new(Diagnostics::default());
        hub.configure(true);
        let trace = Trace::new(hub.clone(), "turn".into(), "chat".into());
        let wire = "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"推理\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"答\"}}]}\n\nevent: error\ndata: {\"error\":\"provider failed\"}\n\n";
        let frames = wire
            .as_bytes()
            .iter()
            .map(|byte| Ok(vec![*byte]))
            .collect::<Vec<Result<Vec<u8>, std::io::Error>>>();
        let mut stream = trace_stream(Box::pin(futures_util::stream::iter(frames)), trace);
        let mut actual = Vec::new();
        while let Some(frame) = stream.next().await {
            actual.extend(frame.unwrap());
        }
        assert_eq!(actual, wire.as_bytes());
        let events = hub.view(0);
        for name in ["server.first_reasoning_token", "server.first_content_token"] {
            assert_eq!(
                events["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|entry| entry["event"] == name)
                    .count(),
                1
            );
        }
        assert!(
            events["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["event"] == "provider.error" && entry["level"] == "error")
        );
    }
}
