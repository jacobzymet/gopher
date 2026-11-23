//! OpenAI Responses API conversion and SSE translation.
//!
//! Chat and agent code speak OpenAI chat-completions. Codex and providers set
//! to the Responses style require Responses. This module converts the request and turns the
//! Responses stream back into chat-completion chunks.

use serde_json::{Value, json};

/// Instructions sent to the Codex backend when the conversation has no system
/// prompt; it rejects requests without them.
const CODEX_DEFAULT_INSTRUCTIONS: &str = "You are a helpful assistant.";

/// Convert an OpenAI chat-completions body into a Responses request.
/// `codex` shapes the body for the ChatGPT Codex backend: it requires
/// `instructions` and `store: false`, and rejects `max_output_tokens`.
pub fn openai_chat_to_responses(payload: &Value, codex: bool) -> Value {
    let model = payload
        .get("model")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let mut instructions = String::new();
    let mut input = Vec::new();
    if let Some(messages) = payload.get("messages").and_then(|value| value.as_array()) {
        for message in messages {
            let role = message
                .get("role")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            match role {
                "system" | "developer" => {
                    let text = content_text(message.get("content"));
                    if !text.is_empty() {
                        if !instructions.is_empty() {
                            instructions.push_str("\n\n");
                        }
                        instructions.push_str(&text);
                    }
                }
                "tool" => {
                    let call_id = message
                        .get("tool_call_id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    input.push(json!({
                        "type": "function_call_output",
                        "call_id": call_id,
                        "output": content_text(message.get("content")),
                    }));
                }
                "assistant" => {
                    if let Some(calls) =
                        message.get("tool_calls").and_then(|value| value.as_array())
                    {
                        for call in calls {
                            let function = &call["function"];
                            input.push(json!({
                                "type": "function_call",
                                "call_id": call.get("id").and_then(|value| value.as_str()).unwrap_or(""),
                                "name": function.get("name").and_then(|value| value.as_str()).unwrap_or(""),
                                "arguments": function.get("arguments").and_then(|value| value.as_str()).unwrap_or("{}"),
                            }));
                        }
                    }
                    let text = content_text(message.get("content"));
                    if !text.is_empty() {
                        input.push(json!({ "role": "assistant", "content": text }));
                    }
                }
                _ => {
                    input.push(user_input(message.get("content")));
                }
            }
        }
    }
    let mut body = json!({
        "model": model,
        "input": input,
        "stream": payload.get("stream").and_then(|value| value.as_bool()).unwrap_or(true),
    });
    if codex && instructions.trim().is_empty() {
        instructions = CODEX_DEFAULT_INSTRUCTIONS.to_string();
    }
    if !instructions.is_empty() {
        body["instructions"] = json!(instructions);
    }
    if let Some(tools) = convert_tools(payload.get("tools")) {
        body["tools"] = Value::Array(tools);
        body["tool_choice"] = responses_tool_choice(payload.get("tool_choice"));
        body["parallel_tool_calls"] = json!(
            payload
                .get("parallel_tool_calls")
                .and_then(Value::as_bool)
                .unwrap_or(true)
        );
    }
    if !codex
        && let Some(max) = payload
            .get("max_tokens")
            .or_else(|| payload.get("max_completion_tokens"))
            .or_else(|| payload.get("max_output_tokens"))
    {
        body["max_output_tokens"] = max.clone();
    }
    if let Some(reasoning) = responses_reasoning(payload) {
        body["reasoning"] = reasoning;
    }
    if codex {
        body["store"] = json!(false);
    }
    body
}

fn responses_tool_choice(choice: Option<&Value>) -> Value {
    match choice {
        Some(Value::String(choice)) if matches!(choice.as_str(), "auto" | "none" | "required") => {
            json!(choice)
        }
        Some(choice) => choice
            .pointer("/function/name")
            .or_else(|| choice.get("name"))
            .and_then(Value::as_str)
            .map(|name| json!({"type": "function", "name": name}))
            .unwrap_or_else(|| json!("auto")),
        None => json!("auto"),
    }
}

/// Keep the catalog's reasoning object, including an explicit disable effort.
fn responses_reasoning(payload: &Value) -> Option<Value> {
    if let Some(object) = payload.get("reasoning").and_then(|value| value.as_object()) {
        let effort = object.get("effort").and_then(|value| value.as_str());
        if effort.is_some_and(|effort| effort.trim().is_empty()) {
            return None;
        }
        if object.is_empty() {
            return None;
        }
        return Some(Value::Object(object.clone()));
    }
    let effort = payload
        .get("reasoning_effort")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|effort| !effort.is_empty())?;
    Some(json!({ "effort": effort }))
}

fn user_input(content: Option<&Value>) -> Value {
    match content {
        Some(Value::Array(parts)) => {
            let mut converted = Vec::new();
            for part in parts {
                let kind = part
                    .get("type")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                if kind == "image_url" {
                    if let Some(url) = part
                        .pointer("/image_url/url")
                        .and_then(|value| value.as_str())
                    {
                        converted.push(json!({ "type": "input_image", "image_url": url }));
                    }
                } else if let Some(text) = part.get("text").and_then(|value| value.as_str()) {
                    converted.push(json!({ "type": "input_text", "text": text }));
                }
            }
            json!({ "role": "user", "content": converted })
        }
        _ => json!({ "role": "user", "content": content_text(content) }),
    }
}

fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(|value| value.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn convert_tools(tools: Option<&Value>) -> Option<Vec<Value>> {
    let tools = tools?.as_array()?;
    let converted: Vec<Value> = tools
        .iter()
        .filter_map(|tool| {
            let function = tool.get("function")?;
            let name = function.get("name")?.as_str()?;
            Some(json!({
                "type": "function",
                "name": name,
                "strict": function.get("strict").and_then(Value::as_bool).unwrap_or(false),
                "description": function.get("description").and_then(|value| value.as_str()).unwrap_or(""),
                "parameters": function.get("parameters").cloned().unwrap_or_else(|| json!({
                    "type": "object",
                    "properties": {}
                })),
            }))
        })
        .collect();
    if converted.is_empty() {
        None
    } else {
        Some(converted)
    }
}

pub fn responses_output_text(body: &Value) -> String {
    if let Some(text) = body.get("output_text").and_then(|value| value.as_str()) {
        return text.to_string();
    }
    let mut out = String::new();
    let Some(items) = body.get("output").and_then(|value| value.as_array()) else {
        return out;
    };
    for item in items {
        if let Some(content) = item.get("content").and_then(|value| value.as_array()) {
            for part in content {
                if let Some(text) = part.get("text").and_then(|value| value.as_str()) {
                    out.push_str(text);
                }
            }
        }
    }
    out
}

#[derive(Default)]
pub struct ResponsesSseTranslator {
    event: String,
    finished: bool,
    /// `(item id, call id)` per function call, in stream order.
    tools: Vec<(String, String)>,
}

impl ResponsesSseTranslator {
    pub fn is_finished(&self) -> bool {
        self.finished
    }

    /// Translate one SSE line into zero or more OpenAI chat-completion frames.
    /// A failed response or error event becomes `Err` with the provider's message.
    pub fn push_line(&mut self, line: &str) -> Result<Vec<Vec<u8>>, String> {
        if self.finished {
            return Ok(Vec::new());
        }
        let line = line.trim_end_matches('\r');
        if let Some(name) = line.strip_prefix("event:") {
            self.event = name.trim().to_string();
            return Ok(Vec::new());
        }
        let Some(data) = line.strip_prefix("data:") else {
            return Ok(Vec::new());
        };
        let data = data.trim();
        if data.is_empty() {
            return Ok(Vec::new());
        }
        if data == "[DONE]" {
            self.finished = true;
            return Ok(vec![b"data: [DONE]\n\n".to_vec()]);
        }
        let Ok(value) = serde_json::from_str::<Value>(data) else {
            return Ok(Vec::new());
        };
        let kind = value
            .get("type")
            .and_then(|item| item.as_str())
            .unwrap_or(self.event.as_str());
        if kind == "response.failed" || kind == "error" {
            return Err(stream_error_message(&value));
        }
        if kind == "response.incomplete" {
            let reason = value
                .pointer("/response/incomplete_details/reason")
                .and_then(Value::as_str)
                .unwrap_or("unknown reason");
            return Err(format!("The model response was incomplete: {reason}"));
        }
        if kind == "response.completed" {
            self.finished = true;
            let mut frames = Vec::new();
            if let Some(source) = value.pointer("/response/usage").and_then(Value::as_object) {
                let mut usage = serde_json::Map::new();
                for (from, to) in [
                    ("input_tokens", "prompt_tokens"),
                    ("output_tokens", "completion_tokens"),
                    ("total_tokens", "total_tokens"),
                ] {
                    if let Some(count) = source.get(from).and_then(Value::as_u64) {
                        usage.insert(to.into(), json!(count));
                    }
                }
                for (from, to) in [
                    ("input_tokens_details", "prompt_tokens_details"),
                    ("output_tokens_details", "completion_tokens_details"),
                ] {
                    if let Some(details) = source.get(from).filter(|value| value.is_object()) {
                        usage.insert(to.into(), details.clone());
                    }
                }
                if !usage.is_empty() {
                    frames.push(
                        format!("data: {}\n\n", json!({"choices": [], "usage": usage}))
                            .into_bytes(),
                    );
                }
            }
            frames.push(b"data: [DONE]\n\n".to_vec());
            return Ok(frames);
        }
        let frames = match kind {
            "response.output_text.delta" => delta_text("content", value.get("delta")),
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                delta_text("reasoning_content", value.get("delta"))
            }
            "response.output_item.added" => self.tool_started(value.get("item")),
            "response.function_call_arguments.delta" => self.tool_arguments(&value),
            _ => Vec::new(),
        };
        Ok(frames
            .into_iter()
            .map(|frame| format!("data: {frame}\n\n").into_bytes())
            .collect())
    }

    fn tool_started(&mut self, item: Option<&Value>) -> Vec<Value> {
        let Some(item) = item else {
            return Vec::new();
        };
        if item.get("type").and_then(|value| value.as_str()) != Some("function_call") {
            return Vec::new();
        }
        let name = item
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let item_id = item
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let id = item
            .get("call_id")
            .and_then(|value| value.as_str())
            .unwrap_or(item_id);
        let index = self.tools.len() as u32;
        self.tools.push((item_id.to_string(), id.to_string()));
        vec![json!({
            "choices": [{
                "index": 0,
                "delta": {
                    "tool_calls": [{
                        "index": index,
                        "id": id,
                        "type": "function",
                        "function": { "name": name, "arguments": "" }
                    }]
                }
            }]
        })]
    }

    fn tool_arguments(&mut self, value: &Value) -> Vec<Value> {
        let delta = value
            .get("delta")
            .and_then(|item| item.as_str())
            .unwrap_or("");
        if delta.is_empty() {
            return Vec::new();
        }
        let id = value
            .get("item_id")
            .or_else(|| value.get("call_id"))
            .and_then(|item| item.as_str())
            .unwrap_or("");
        let index = self
            .tools
            .iter()
            .position(|(item_id, call_id)| !id.is_empty() && (item_id == id || call_id == id))
            .or_else(|| self.tools.len().checked_sub(1))
            .map(|index| index as u32)
            .unwrap_or(0);
        vec![json!({
            "choices": [{
                "index": 0,
                "delta": {
                    "tool_calls": [{
                        "index": index,
                        "function": { "arguments": delta }
                    }]
                }
            }]
        })]
    }
}

fn stream_error_message(value: &Value) -> String {
    let message = value
        .pointer("/response/error/message")
        .or_else(|| value.pointer("/error/message"))
        .or_else(|| value.get("message"))
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or("The model service reported an error.");
    let message: String = message
        .chars()
        .filter(|ch| !ch.is_control())
        .take(400)
        .collect();
    format!("The model service reported an error: {message}")
}

fn delta_text(field: &str, delta: Option<&Value>) -> Vec<Value> {
    let Some(text) = delta.and_then(|value| value.as_str()) else {
        return Vec::new();
    };
    if text.is_empty() {
        return Vec::new();
    }
    vec![json!({
        "choices": [{ "index": 0, "delta": { (field): text } }]
    })]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_a_tool_turn_and_translates_the_stream() {
        let chat = json!({
            "model": "gpt-5.4",
            "stream": true,
            "messages": [
                {"role": "system", "content": "Be brief."},
                {"role": "user", "content": "Read the file"},
                {"role": "assistant", "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "read_file", "arguments": "{\"path\":\"a.txt\"}"}
                }]},
                {"role": "tool", "tool_call_id": "call_1", "content": "hello"}
            ],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Read",
                    "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}
                }
            }]
        });
        let responses = openai_chat_to_responses(&chat, true);
        assert_eq!(responses["store"], json!(false));
        assert_eq!(responses["instructions"], json!("Be brief."));
        assert_eq!(responses["tools"][0]["name"], json!("read_file"));
        assert_eq!(responses["input"][1]["type"], json!("function_call"));
        assert_eq!(responses["input"][2]["type"], json!("function_call_output"));

        let mut translator = ResponsesSseTranslator::default();
        let started = translator
            .push_line(
                "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"id\":\"fc_1\",\"call_id\":\"call_2\",\"name\":\"read_file\"}}",
            )
            .unwrap();
        assert!(String::from_utf8_lossy(&started[0]).contains("read_file"));
        let second = translator
            .push_line(
                "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"id\":\"fc_2\",\"call_id\":\"call_3\",\"name\":\"list_dir\"}}",
            )
            .unwrap();
        assert!(String::from_utf8_lossy(&second[0]).contains("\"index\":1"));
        let args = translator
            .push_line(
                "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"delta\":\"{\\\"path\\\"\"}",
            )
            .unwrap();
        let args = String::from_utf8_lossy(&args[0]);
        assert!(args.contains("arguments"));
        assert!(args.contains("\"index\":0"));
        let text = translator
            .push_line("data: {\"type\":\"response.output_text.delta\",\"delta\":\"done\"}")
            .unwrap();
        let frame = String::from_utf8_lossy(&text[0]);
        assert!(frame.contains("\"content\":\"done\""));
        assert!(frame.starts_with("data: "));
    }

    #[test]
    fn codex_body_always_has_instructions_and_no_output_cap() {
        let chat = json!({
            "model": "gpt-5.4",
            "max_tokens": 64,
            "messages": [{"role": "user", "content": "hey"}]
        });
        let codex = openai_chat_to_responses(&chat, true);
        assert_eq!(codex["instructions"], json!(CODEX_DEFAULT_INSTRUCTIONS));
        assert_eq!(codex["store"], json!(false));
        assert!(codex.get("max_output_tokens").is_none());
        assert!(codex.get("tool_choice").is_none());

        let other = openai_chat_to_responses(&chat, false);
        assert!(other.get("instructions").is_none());
        assert_eq!(other["max_output_tokens"], json!(64));
    }

    #[test]
    fn codex_reasoning_keeps_summary_and_context() {
        let chat = json!({
            "model": "gpt-5.6-sol",
            "messages": [{"role": "user", "content": "hey"}],
            "reasoning": { "effort": "high", "summary": "auto", "context": "all_turns" }
        });
        let codex = openai_chat_to_responses(&chat, true);
        assert_eq!(
            codex["reasoning"],
            json!({ "effort": "high", "summary": "auto", "context": "all_turns" })
        );

        let disabled = json!({
            "model": "gpt-5.6-sol",
            "messages": [{"role": "user", "content": "hey"}],
            "reasoning": { "effort": "none" }
        });
        let codex = openai_chat_to_responses(&disabled, true);
        assert_eq!(codex["reasoning"], json!({ "effort": "none" }));
        let legacy = openai_chat_to_responses(&json!({ "reasoning_effort": "none" }), false);
        assert_eq!(legacy["reasoning"], json!({ "effort": "none" }));
    }

    #[test]
    fn failed_responses_surface_the_provider_message() {
        let mut translator = ResponsesSseTranslator::default();
        let failed = translator.push_line(
            "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"Model not allowed\"}}}",
        );
        assert!(failed.unwrap_err().contains("Model not allowed"));
        let error = translator
            .push_line("data: {\"type\":\"error\",\"message\":\"Instructions are required\"}");
        assert!(error.unwrap_err().contains("Instructions are required"));
    }

    #[test]
    fn preserves_forced_tools_parallel_policy_and_optional_parameters() {
        let mut chat = json!({
            "tools": [{"type": "function", "function": {
                "name": "read_file", "parameters": {"type": "object", "properties": {
                    "path": {"type": "string"}, "offset": {"type": "integer"}
                }, "required": ["path"]}
            }}],
            "parallel_tool_calls": false,
            "max_completion_tokens": 128
        });
        for choice in [
            json!("required"),
            json!("none"),
            json!("auto"),
            json!({"type": "function", "function": {"name": "read_file"}}),
        ] {
            chat["tool_choice"] = choice.clone();
            let result = openai_chat_to_responses(&chat, false);
            let expected = if choice.is_object() {
                json!({"type": "function", "name": "read_file"})
            } else {
                choice
            };
            assert_eq!(result["tool_choice"], expected);
            assert_eq!(result["parallel_tool_calls"], false);
            assert_eq!(result["tools"][0]["strict"], false);
            assert_eq!(
                result["tools"][0]["parameters"],
                chat["tools"][0]["function"]["parameters"]
            );
            assert_eq!(result["max_output_tokens"], 128);
        }
        chat["tools"][0]["function"]["strict"] = json!(true);
        assert_eq!(
            openai_chat_to_responses(&chat, false)["tools"][0]["strict"],
            true
        );
    }

    #[test]
    fn completed_stream_emits_usage_once_and_finishes_without_socket_close() {
        let mut translator = ResponsesSseTranslator::default();
        assert!(translator.push_line("data: ").unwrap().is_empty());
        assert!(!translator.is_finished());
        let source = json!({"type": "response.completed", "response": {"usage": {
            "input_tokens": 37, "output_tokens": 11, "total_tokens": 48,
            "input_tokens_details": {"cached_tokens": 12},
            "output_tokens_details": {"reasoning_tokens": 3}
        }}});
        let frames = translator.push_line(&format!("data: {source}")).unwrap();
        assert!(translator.is_finished());
        assert_eq!(frames.len(), 2);
        let frame = String::from_utf8_lossy(&frames[0]);
        let usage: Value =
            serde_json::from_str(frame.trim().strip_prefix("data:").unwrap().trim()).unwrap();
        assert_eq!(usage["usage"]["prompt_tokens"], 37);
        assert_eq!(usage["usage"]["completion_tokens"], 11);
        assert_eq!(usage["usage"]["total_tokens"], 48);
        assert_eq!(usage["usage"]["prompt_tokens_details"]["cached_tokens"], 12);
        assert_eq!(
            usage["usage"]["completion_tokens_details"]["reasoning_tokens"],
            3
        );
        assert_eq!(frames[1], b"data: [DONE]\n\n");
        assert!(
            translator
                .push_line(&format!("data: {source}"))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn missing_usage_stays_unknown_and_incomplete_streams_fail() {
        let mut translator = ResponsesSseTranslator::default();
        let frames = translator
            .push_line("data: {\"type\":\"response.completed\",\"response\":{\"usage\":null}}")
            .unwrap();
        assert_eq!(frames, vec![b"data: [DONE]\n\n".to_vec()]);
        let mut translator = ResponsesSseTranslator::default();
        let error = translator.push_line("data: {\"type\":\"response.incomplete\",\"response\":{\"incomplete_details\":{\"reason\":\"max_output_tokens\"}}}").unwrap_err();
        assert!(error.contains("max_output_tokens"));
    }
}
