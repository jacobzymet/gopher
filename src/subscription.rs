//! Built-in ChatGPT Codex provider.
//!
//! Codex credentials are sent only to pinned HTTPS hosts, with redirects disabled.

use std::{
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::{
    http,
    providers::{ApiStyle, Provider, ProviderHealth, ProviderHealthKind, ProviderKind, RemoteModelOption},
    system,
};

pub const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
pub const CODEX_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
pub const CODEX_AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
pub const CODEX_DEVICE_URL: &str = "https://auth.openai.com/codex/device";
pub const CODEX_BASE: &str = "https://chatgpt.com/backend-api/codex";
const CODEX_SCOPE: &str = "openid profile email offline_access";
/// OpenAI's public Codex client only accepts `http://localhost:1455/auth/callback`.
const CODEX_CALLBACK_PORT: u16 = 1455;
const CODEX_CALLBACK_PATH: &str = "/auth/callback";
const CODEX_CALLBACK_TIMEOUT_SECS: u64 = 300;
const REFRESH_SKEW_SECS: u64 = 120;

pub const ID_CODEX: &str = "builtin-openai-codex";

#[derive(Clone, Copy)]
pub struct BuiltinSpec {
    pub kind: ProviderKind,
    pub id: &'static str,
    pub name: &'static str,
    pub base: &'static str,
    pub api_style: ApiStyle,
}

pub const BUILTIN_SPECS: &[BuiltinSpec] = &[
    BuiltinSpec {
        kind: ProviderKind::OpenaiCodex,
        id: ID_CODEX,
        name: "ChatGPT",
        base: CODEX_BASE,
        api_style: ApiStyle::Responses,
    },
];

pub fn builtin_spec(kind: ProviderKind) -> Option<&'static BuiltinSpec> {
    BUILTIN_SPECS.iter().find(|spec| spec.kind == kind)
}

#[derive(Clone, Debug)]
pub struct PreparedUpstream {
    pub api_base: String,
    pub token: String,
    pub style: ApiStyle,
    pub allow_insecure_tls: bool,
    pub extra_headers: Vec<(String, String)>,
    pub no_redirect: bool,
    pub kind: ProviderKind,
    pub wire_model: String,
}

pub fn prepare(
    provider: &Provider,
    model: &str,
    conversation_id: Option<&str>,
) -> Result<PreparedUpstream, String> {
    if provider.kind == ProviderKind::Custom {
        let base = crate::providers::normalize_provider_base(&provider.base, provider.api_style)
            .ok_or_else(|| "Invalid model API base.".to_string())?;
        return Ok(PreparedUpstream {
            api_base: base,
            token: provider.token.clone(),
            style: provider.api_style,
            allow_insecure_tls: provider.allow_insecure_tls,
            extra_headers: Vec::new(),
            no_redirect: false,
            kind: ProviderKind::Custom,
            wire_model: model.to_string(),
        });
    }
    if provider.kind != ProviderKind::OpenaiCodex {
        return Err("Unknown built-in provider.".into());
    }
    if provider.allow_insecure_tls {
        return Err("Built-in providers cannot skip certificate checks.".into());
    }
    require_request_url(provider.kind, &format!("{CODEX_BASE}/"))?;
    let (token, extra_headers) = codex_request_headers(&provider.token, conversation_id)?;
    Ok(PreparedUpstream {
        api_base: CODEX_BASE.to_string(),
        token,
        style: ApiStyle::Responses,
        allow_insecure_tls: false,
        extra_headers,
        no_redirect: true,
        kind: provider.kind,
        wire_model: model.trim().to_string(),
    })
}

pub fn require_request_url(kind: ProviderKind, url: &str) -> Result<(), String> {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return Err("Refused a non-URL provider request.".into());
    };
    if parsed.scheme() != "https" {
        return Err("Built-in providers only use HTTPS.".into());
    }
    let host = parsed.host_str().unwrap_or("");
    let path = parsed.path();
    let ok = kind == ProviderKind::OpenaiCodex
        && host == "chatgpt.com"
        && path.starts_with("/backend-api/codex/");
    if ok {
        Ok(())
    } else {
        Err("Refused to send this credential to an unexpected host.".into())
    }
}

fn codex_request_headers(
    stored: &str,
    conversation_id: Option<&str>,
) -> Result<(String, Vec<(String, String)>), String> {
    let secret = CodexSecret::parse(stored)?;
    if secret.refresh_dead || secret.access_token.trim().is_empty() {
        return Err("Sign in to ChatGPT again.".into());
    }
    let mut headers = codex_identity_headers();
    headers.extend(codex_account_headers(&secret.access_token));
    // The raw conversation id stays local; Codex gets a keyed hash for session affinity.
    if let Some(id) = conversation_id.map(str::trim).filter(|id| !id.is_empty()) {
        headers.push(("session_id".into(), session_hmac(id)));
    }
    Ok((secret.access_token.clone(), headers))
}

fn session_key() -> &'static [u8; 32] {
    static KEY: OnceLock<[u8; 32]> = OnceLock::new();
    KEY.get_or_init(|| {
        let mut bytes = [0u8; 32];
        let _ = getrandom::fill(&mut bytes);
        bytes
    })
}

fn session_hmac(material: &str) -> String {
    let mac = hmac_sha256(session_key(), material.as_bytes());
    hex_encode(&mac)
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut key_block = if key.len() > 64 {
        Sha256::digest(key).to_vec()
    } else {
        key.to_vec()
    };
    key_block.resize(64, 0);
    let mut ipad = vec![0x36u8; 64];
    let mut opad = vec![0x5cu8; 64];
    for index in 0..64 {
        ipad[index] ^= key_block[index];
        opad[index] ^= key_block[index];
    }
    key_block.zeroize();
    let mut inner = Sha256::new();
    inner.update(&ipad);
    inner.update(message);
    ipad.zeroize();
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(&opad);
    outer.update(inner);
    opad.zeroize();
    outer.finalize().into()
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

pub fn codex_account_headers(access_token: &str) -> Vec<(String, String)> {
    let mut headers = Vec::new();
    let Some(claims) = jwt_auth_claims(access_token) else {
        return headers;
    };
    if let Some(account) = claims
        .get("chatgpt_account_id")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        headers.push(("ChatGPT-Account-ID".into(), account.to_string()));
    }
    let residency = claims
        .get("chatgpt_data_residency")
        .and_then(|value| value.as_str())
        .or_else(|| {
            claims
                .get("chatgpt_compute_residency")
                .and_then(|value| value.as_str())
        })
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(residency) = residency {
        headers.push((
            "x-openai-internal-codex-residency".into(),
            residency.to_string(),
        ));
    }
    headers
}

/// OpenAI requires third-party Codex clients to identify themselves; the
/// pinned clients already send the `gopher/<version>` User-Agent.
fn codex_identity_headers() -> Vec<(String, String)> {
    vec![("originator".into(), "gopher".into())]
}

fn jwt_auth_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    claims
        .get("https://api.openai.com/auth")
        .cloned()
        .or_else(|| Some(claims))
}

fn jwt_expiry(token: &str) -> Option<u64> {
    let payload = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    claims.get("exp").and_then(|value| value.as_u64())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CodexSecret {
    access_token: String,
    refresh_token: String,
    #[serde(default)]
    expires_at: u64,
    #[serde(default)]
    refresh_dead: bool,
}

impl CodexSecret {
    fn parse(raw: &str) -> Result<Self, String> {
        let raw = raw.trim();
        if raw.is_empty() {
            return Err("Sign in to ChatGPT to use Codex models.".into());
        }
        serde_json::from_str(raw).map_err(|_| "Sign in to ChatGPT again.".to_string())
    }

    fn expiring(&self) -> bool {
        if self.access_token.trim().is_empty() {
            return true;
        }
        let exp = if self.expires_at > 0 {
            self.expires_at
        } else {
            jwt_expiry(&self.access_token).unwrap_or(0)
        };
        if exp == 0 {
            return false;
        }
        now_secs().saturating_add(REFRESH_SKEW_SECS) >= exp
    }
}

impl Drop for CodexSecret {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

pub struct CodexRefresh {
    pub secret_json: String,
    pub changed: bool,
}

/// Refresh a Codex access token when it is near expiry. A terminal auth failure
/// marks the refresh token dead so it is not replayed.
pub fn refresh_codex_secret(stored: &str) -> Result<CodexRefresh, String> {
    let mut secret = CodexSecret::parse(stored)?;
    if secret.refresh_dead {
        return Err("Sign in to ChatGPT again.".into());
    }
    if !secret.expiring() {
        return Ok(CodexRefresh {
            secret_json: stored.to_string(),
            changed: false,
        });
    }
    if secret.refresh_token.trim().is_empty() {
        secret.refresh_dead = true;
        return Ok(CodexRefresh {
            secret_json: serde_json::to_string(&secret).unwrap_or_default(),
            changed: true,
        });
    }
    let client = http::pinned_blocking_client(Duration::from_secs(20));
    let response = client
        .post(CODEX_TOKEN_URL)
        .header("Accept", "application/json")
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", secret.refresh_token.as_str()),
            ("client_id", CODEX_CLIENT_ID),
        ])
        .send()
        .map_err(|_| "Could not refresh the ChatGPT sign-in.".to_string())?;
    let status = response.status();
    if status.is_redirection() {
        return Err("ChatGPT auth redirected. Gopher did not follow it.".into());
    }
    if status.is_client_error() {
        secret.refresh_dead = true;
        return Ok(CodexRefresh {
            secret_json: serde_json::to_string(&secret).unwrap_or_default(),
            changed: true,
        });
    }
    if !status.is_success() {
        return Err("Could not refresh the ChatGPT sign-in.".into());
    }
    let body: Value = response
        .json()
        .map_err(|_| "ChatGPT auth returned an unreadable response.".to_string())?;
    let access = body
        .get("access_token")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if access.is_empty() {
        return Err("ChatGPT auth did not return an access token.".into());
    }
    let refresh = body
        .get("refresh_token")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(secret.refresh_token.as_str())
        .to_string();
    let expires_in = body.get("expires_in").and_then(|value| value.as_u64()).unwrap_or(3600);
    secret.access_token = access;
    secret.refresh_token = refresh;
    secret.expires_at = now_secs().saturating_add(expires_in);
    secret.refresh_dead = false;
    let secret_json = serde_json::to_string(&secret).unwrap_or_default();
    Ok(CodexRefresh {
        secret_json,
        changed: true,
    })
}

pub fn redact(text: &str, secrets: &[&str]) -> String {
    let mut out = text.to_string();
    for secret in secrets {
        let secret = secret.trim();
        if secret.len() >= 8 {
            out = out.replace(secret, "[redacted]");
        }
    }
    if out.len() > 500 {
        out.truncate(500);
    }
    out
}

pub fn probe_builtin(kind: ProviderKind, stored: &str) -> (ProviderHealth, Vec<RemoteModelOption>) {
    match kind {
        ProviderKind::OpenaiCodex => probe_codex(stored),
        ProviderKind::Custom | ProviderKind::Retired => (
            ProviderHealth {
                ok: false,
                kind: ProviderHealthKind::Error,
                model: None,
                status: None,
                error: Some("Not a built-in provider.".into()),
            },
            Vec::new(),
        ),
    }
}

fn probe_codex(stored: &str) -> (ProviderHealth, Vec<RemoteModelOption>) {
    let secret = match CodexSecret::parse(stored) {
        Ok(secret) if !secret.refresh_dead && !secret.access_token.trim().is_empty() => secret,
        _ => {
            return (
                health_error(ProviderHealthKind::Auth, "Sign in to ChatGPT to list Codex models."),
                Vec::new(),
            );
        }
    };
    let url = format!("{CODEX_BASE}/models?client_version=1.0.0");
    if require_request_url(ProviderKind::OpenaiCodex, &url).is_err() {
        return (health_error(ProviderHealthKind::Error, "Codex catalog URL was rejected."), Vec::new());
    }
    let client = http::pinned_blocking_client(Duration::from_secs(10));
    let mut request = client.get(&url).header("Accept", "application/json");
    request = request.header("Authorization", format!("Bearer {}", secret.access_token));
    for (name, value) in codex_identity_headers()
        .into_iter()
        .chain(codex_account_headers(&secret.access_token))
    {
        request = request.header(name, value);
    }
    match request.send() {
        Ok(response) if response.status().is_redirection() => (
            health_error(
                ProviderHealthKind::Error,
                "Codex catalog redirected. Gopher did not follow it.",
            ),
            local_codex_models(),
        ),
        Ok(response) if response.status().is_success() => {
            let body: Value = response.json().unwrap_or(Value::Null);
            let models = codex_catalog_models(&body);
            if models.is_empty() {
                (
                    health_error(ProviderHealthKind::Empty, "ChatGPT returned no Codex models."),
                    Vec::new(),
                )
            } else {
                (health_ok(&models[0].model), models)
            }
        }
        Ok(response) if response.status().as_u16() == 401 => (
            health_error(ProviderHealthKind::Auth, "Sign in to ChatGPT again."),
            Vec::new(),
        ),
        _ => (
            health_error(ProviderHealthKind::Waiting, "Codex catalog is unavailable."),
            local_codex_models(),
        ),
    }
}

/// Efforts the shared thinking control already knows how to send. Codex-only
/// names such as `xhigh` and `ultra` stay in this file and are not advertised.
const SHARED_THINKING_EFFORTS: &[&str] = &["low", "medium", "high", "max"];

fn codex_catalog_models(body: &Value) -> Vec<RemoteModelOption> {
    let entries = body.get("models").and_then(|value| value.as_array());
    let Some(entries) = entries else {
        return Vec::new();
    };
    let mut ranked = Vec::new();
    for item in entries {
        let Some(slug) = item.get("slug").and_then(|value| value.as_str()).map(str::trim) else {
            continue;
        };
        if slug.is_empty() {
            continue;
        }
        if item
            .get("visibility")
            .and_then(|value| value.as_str())
            .is_some_and(|visibility| {
                matches!(visibility.trim().to_ascii_lowercase().as_str(), "hide" | "hidden")
            })
        {
            continue;
        }
        let priority = item
            .get("priority")
            .and_then(|value| value.as_i64())
            .unwrap_or(10_000);
        ranked.push((
            priority,
            slug.to_string(),
            codex_thinking_efforts(item),
            codex_reasoning_wire(item),
        ));
    }
    ranked.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
    let mut out = Vec::new();
    for (_, slug, efforts, wire) in ranked {
        if out.iter().any(|existing: &RemoteModelOption| existing.model == slug) {
            continue;
        }
        out.push(codex_model_option(&slug, &efforts, wire));
    }
    out
}

/// Summary and context values the Codex backend expects beside `reasoning.effort`.
/// Responses Lite models include `context: all_turns`. `detailed` is the summary
/// value that streams a reasoning trace. The catalog omits the summary flag when
/// the model accepts one.
fn codex_reasoning_wire(item: &Value) -> (Option<String>, Option<String>) {
    let summary = item
        .get("supports_reasoning_summary_parameter")
        .and_then(|value| value.as_bool())
        .unwrap_or(true)
        .then(|| "detailed".to_string());
    let context = item
        .get("use_responses_lite")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
        .then(|| "all_turns".to_string());
    (summary, context)
}

fn codex_thinking_efforts(item: &Value) -> Vec<String> {
    let Some(levels) = item
        .get("supported_reasoning_levels")
        .and_then(|value| value.as_array())
    else {
        return Vec::new();
    };
    let mut efforts = Vec::new();
    for level in levels {
        let Some(effort) = level
            .get("effort")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|effort| !effort.is_empty())
        else {
            continue;
        };
        let effort = effort.to_ascii_lowercase();
        if !SHARED_THINKING_EFFORTS
            .iter()
            .any(|known| *known == effort)
            || efforts.iter().any(|existing| existing == &effort)
        {
            continue;
        }
        efforts.push(effort);
    }
    efforts
}

/// Models already recorded by the Codex CLI on this machine. Used only when the
/// live account catalog cannot be fetched. Gopher does not invent slugs.
fn local_codex_models() -> Vec<RemoteModelOption> {
    let mut models = read_codex_cache_models();
    if let Some(slug) = read_codex_default_model() {
        if let Some(index) = models.iter().position(|existing| existing.model == slug) {
            let preferred = models.remove(index);
            models.insert(0, preferred);
        } else {
            models.insert(0, codex_model_option(&slug, &[], (None, None)));
        }
    }
    models
}

fn codex_home() -> PathBuf {
    if let Some(home) = std::env::var_os("CODEX_HOME") {
        return PathBuf::from(home);
    }
    directories::UserDirs::new()
        .map(|dirs| dirs.home_dir().join(".codex"))
        .unwrap_or_else(|| PathBuf::from(".codex"))
}

fn read_codex_default_model() -> Option<String> {
    let text = std::fs::read_to_string(codex_home().join("config.toml")).ok()?;
    let value: toml::Value = toml::from_str(&text).ok()?;
    value
        .get("model")
        .and_then(|model| model.as_str())
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_string)
}

fn read_codex_cache_models() -> Vec<RemoteModelOption> {
    let text = match std::fs::read_to_string(codex_home().join("models_cache.json")) {
        Ok(text) => text,
        Err(_) => return Vec::new(),
    };
    let Ok(body) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    codex_catalog_models(&body)
}

fn codex_model_option(
    model: &str,
    efforts: &[String],
    wire: (Option<String>, Option<String>),
) -> RemoteModelOption {
    let controllable = !efforts.is_empty();
    let (reasoning_summary, reasoning_context) = if controllable {
        wire
    } else {
        (None, None)
    };
    RemoteModelOption {
        id: format!("remote|{CODEX_BASE}|{model}"),
        model: model.to_string(),
        base: CODEX_BASE.to_string(),
        port: 443,
        ready: true,
        label: model.to_string(),
        thinking_supported: controllable,
        thinking_control: controllable.then(|| "reasoning".to_string()),
        thinking_efforts: efforts.to_vec(),
        thinking_can_disable: false,
        reasoning_summary,
        reasoning_context,
        attachments_supported: false,
        context_length: None,
        prompt_progress_supported: false,
        provider_id: String::new(),
        provider_name: String::new(),
        request_style: ApiStyle::Responses,
        connect_kind: None,
    }
}

fn health_ok(model: &str) -> ProviderHealth {
    ProviderHealth {
        ok: true,
        kind: ProviderHealthKind::Ready,
        model: Some(model.to_string()),
        status: Some("ready".into()),
        error: None,
    }
}

fn health_error(kind: ProviderHealthKind, message: &str) -> ProviderHealth {
    ProviderHealth {
        ok: false,
        kind,
        model: None,
        status: None,
        error: Some(message.to_string()),
    }
}

pub fn connect_option(provider: &Provider) -> Option<RemoteModelOption> {
    if !provider.kind.needs_secret() || !provider.token.trim().is_empty() {
        return None;
    }
    let spec = builtin_spec(provider.kind)?;
    Some(RemoteModelOption {
        id: format!("connect|{}", provider.id),
        model: String::new(),
        base: spec.base.to_string(),
        port: 443,
        ready: false,
        label: "Connect ChatGPT".to_string(),
        thinking_supported: false,
        thinking_control: None,
        thinking_efforts: Vec::new(),
        thinking_can_disable: false,
        reasoning_summary: None,
        reasoning_context: None,
        attachments_supported: false,
        context_length: None,
        prompt_progress_supported: false,
        provider_id: provider.id.clone(),
        provider_name: spec.name.to_string(),
        request_style: spec.api_style,
        connect_kind: Some(provider.kind.as_str().to_string()),
    })
}

pub fn codex_secret_from_tokens(access_token: &str, refresh_token: &str, expires_in: Option<u64>) -> String {
    let expires_at = expires_in
        .map(|seconds| now_secs().saturating_add(seconds))
        .or_else(|| jwt_expiry(access_token))
        .unwrap_or(0);
    let secret = CodexSecret {
        access_token: access_token.trim().to_string(),
        refresh_token: refresh_token.trim().to_string(),
        expires_at,
        refresh_dead: false,
    };
    serde_json::to_string(&secret).unwrap_or_default()
}

pub fn import_codex_cli_secret() -> Result<String, String> {
    let path = codex_home().join("auth.json");
    let text = std::fs::read_to_string(&path).map_err(|_| {
        "No Codex CLI credentials were found in the Codex home folder.".to_string()
    })?;
    let body: Value = serde_json::from_str(&text)
        .map_err(|_| "Codex CLI credentials could not be read.".to_string())?;
    let tokens = body.get("tokens").unwrap_or(&body);
    let access = tokens
        .get("access_token")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();
    let refresh = tokens
        .get("refresh_token")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();
    if access.is_empty() || refresh.is_empty() {
        return Err("Codex CLI credentials did not include a ChatGPT session.".into());
    }
    Ok(codex_secret_from_tokens(access, refresh, None))
}

pub struct PkceLogin {
    pub secret_json: String,
}

pub enum PkceError {
    /// Port 1455 is taken (usually a Codex CLI login in progress). Use the device code instead.
    PortBusy,
    Failed(String),
}

impl From<String> for PkceError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

pub fn codex_pkce_login() -> Result<PkceLogin, PkceError> {
    let verifier = random_token(64);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_token(32);
    let listener = TcpListener::bind(("127.0.0.1", CODEX_CALLBACK_PORT))
        .map_err(|_| PkceError::PortBusy)?;
    let redirect_uri = format!("http://localhost:{CODEX_CALLBACK_PORT}{CODEX_CALLBACK_PATH}");
    let auth_url = authorize_url(&redirect_uri, &challenge, &state);
    listener
        .set_nonblocking(true)
        .map_err(|_| "Could not open a local sign-in callback.".to_string())?;
    system::open_in_browser(&auth_url).map_err(|_| {
        "Could not open the browser. Use the device-code sign-in instead.".to_string()
    })?;
    let deadline = std::time::Instant::now() + Duration::from_secs(CODEX_CALLBACK_TIMEOUT_SECS);
    let code = loop {
        let (mut stream, peer) = match listener.accept() {
            Ok(pair) => pair,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if std::time::Instant::now() >= deadline {
                    return Err("ChatGPT sign-in timed out before the browser returned."
                        .to_string()
                        .into());
                }
                std::thread::sleep(Duration::from_millis(200));
                continue;
            }
            Err(_) => continue,
        };
        if !peer.ip().is_loopback() {
            continue;
        }
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut buffer = [0u8; 8192];
        let read = stream.read(&mut buffer).unwrap_or(0);
        let request = String::from_utf8_lossy(&buffer[..read]);
        // Browsers open speculative connections and fetch /favicon.ico. Only the
        // callback path ends the wait.
        if !is_callback_request(&request) {
            let _ = stream.write_all(CALLBACK_NOT_FOUND.as_bytes());
            continue;
        }
        match callback_code(&request, &state) {
            Ok(code) => {
                let _ = stream.write_all(CALLBACK_OK.as_bytes());
                break code;
            }
            Err(error) => {
                let _ = stream.write_all(CALLBACK_ERR.as_bytes());
                return Err(error.into());
            }
        }
    };
    drop(listener);
    let secret_json = exchange_authorization_code(&code, &verifier, &redirect_uri)?;
    Ok(PkceLogin { secret_json })
}

fn is_callback_request(request: &str) -> bool {
    let line = request.lines().next().unwrap_or("");
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts
        .next()
        .unwrap_or("")
        .split('?')
        .next()
        .unwrap_or("");
    method.eq_ignore_ascii_case("GET") && path == CODEX_CALLBACK_PATH
}

fn authorize_url(redirect_uri: &str, challenge: &str, state: &str) -> String {
    let mut url = reqwest::Url::parse(CODEX_AUTHORIZE_URL).expect("authorize url");
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CODEX_CLIENT_ID)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", CODEX_SCOPE)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("id_token_add_organizations", "true")
        .append_pair("state", state);
    url.to_string()
}

fn random_token(bytes: usize) -> String {
    let mut raw = vec![0u8; bytes];
    let _ = getrandom::fill(&mut raw);
    URL_SAFE_NO_PAD.encode(raw)
}

const CALLBACK_OK: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<!doctype html><title>Gopher</title><p>ChatGPT sign-in completed. You can close this tab.</p>";
const CALLBACK_ERR: &str = "HTTP/1.1 400 Bad Request\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<!doctype html><title>Gopher</title><p>ChatGPT sign-in was rejected.</p>";
const CALLBACK_NOT_FOUND: &str =
    "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

pub fn callback_code(request: &str, expected_state: &str) -> Result<String, String> {
    if !is_callback_request(request) {
        return Err("Rejected an unexpected sign-in callback.".into());
    }
    let target = request
        .lines()
        .next()
        .unwrap_or("")
        .split_whitespace()
        .nth(1)
        .unwrap_or("");
    let query = target.split_once('?').map(|(_, query)| query).unwrap_or("");
    let mut code = None;
    let mut state = None;
    let mut error = None;
    let mut error_description = None;
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        let value = urlencoding_decode(value);
        match key {
            "code" => code = Some(value),
            "state" => state = Some(value),
            "error" => error = Some(value),
            "error_description" => error_description = Some(value),
            _ => {}
        }
    }
    if let Some(error) = error {
        let detail: String = error_description
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(error)
            .chars()
            .filter(|c| !c.is_control())
            .take(200)
            .collect();
        return Err(format!("OpenAI authorization failed: {detail}"));
    }
    let Some(state) = state else {
        return Err("ChatGPT sign-in did not include a state value.".into());
    };
    if !constant_eq(state.as_bytes(), expected_state.as_bytes()) {
        return Err("ChatGPT sign-in state did not match.".into());
    }
    code.filter(|value| !value.is_empty())
        .ok_or_else(|| "ChatGPT sign-in did not include a code.".to_string())
}

fn urlencoding_decode(value: &str) -> String {
    let mut out = Vec::new();
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => out.push(b' '),
            b'%' if index + 2 < bytes.len() => {
                let hex = &value[index + 1..index + 3];
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte);
                    index += 2;
                }
            }
            byte => out.push(byte),
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn constant_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right) {
        diff |= a ^ b;
    }
    diff == 0
}

fn exchange_authorization_code(code: &str, verifier: &str, redirect_uri: &str) -> Result<String, String> {
    let client = http::pinned_blocking_client(Duration::from_secs(20));
    let response = client
        .post(CODEX_TOKEN_URL)
        .header("Accept", "application/json")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("client_id", CODEX_CLIENT_ID),
            ("code_verifier", verifier),
        ])
        .send()
        .map_err(|_| "Could not finish the ChatGPT sign-in.".to_string())?;
    if response.status().is_redirection() {
        return Err("ChatGPT auth redirected. Gopher did not follow it.".into());
    }
    if !response.status().is_success() {
        return Err("ChatGPT rejected the sign-in.".into());
    }
    let body: Value = response
        .json()
        .map_err(|_| "ChatGPT auth returned an unreadable response.".to_string())?;
    let access = body.get("access_token").and_then(|value| value.as_str()).unwrap_or("");
    let refresh = body.get("refresh_token").and_then(|value| value.as_str()).unwrap_or("");
    if access.is_empty() || refresh.is_empty() {
        return Err("ChatGPT did not return a session.".into());
    }
    let expires_in = body.get("expires_in").and_then(|value| value.as_u64());
    Ok(codex_secret_from_tokens(access, refresh, expires_in))
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceCode {
    pub user_code: String,
    pub verification_url: String,
    pub device_auth_id: String,
    pub interval_secs: u64,
}

pub fn request_device_code() -> Result<DeviceCode, String> {
    let client = http::pinned_blocking_client(Duration::from_secs(20));
    let response = client
        .post("https://auth.openai.com/api/accounts/deviceauth/usercode")
        .json(&json!({ "client_id": CODEX_CLIENT_ID }))
        .send()
        .map_err(|_| "Could not start device-code sign-in.".to_string())?;
    if !response.status().is_success() {
        return Err("ChatGPT did not start a device-code sign-in.".into());
    }
    let body: Value = response
        .json()
        .map_err(|_| "ChatGPT returned an unreadable device code.".to_string())?;
    let user_code = body.get("user_code").and_then(|value| value.as_str()).unwrap_or("").trim().to_string();
    let device_auth_id = body
        .get("device_auth_id")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if user_code.is_empty() || device_auth_id.is_empty() {
        return Err("ChatGPT returned an incomplete device code.".into());
    }
    let interval = body.get("interval").and_then(|value| value.as_u64()).unwrap_or(5).max(3);
    Ok(DeviceCode {
        user_code,
        verification_url: CODEX_DEVICE_URL.to_string(),
        device_auth_id,
        interval_secs: interval,
    })
}

pub fn poll_device_code(user_code: &str, device_auth_id: &str) -> Result<Option<String>, String> {
    let client = http::pinned_blocking_client(Duration::from_secs(20));
    let response = client
        .post("https://auth.openai.com/api/accounts/deviceauth/token")
        .json(&json!({
            "device_auth_id": device_auth_id,
            "user_code": user_code,
        }))
        .send()
        .map_err(|_| "Could not check the device-code sign-in.".to_string())?;
    if response.status().as_u16() == 403 || response.status().as_u16() == 404 {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err("ChatGPT device-code sign-in failed.".into());
    }
    let body: Value = response
        .json()
        .map_err(|_| "ChatGPT returned an unreadable device-code response.".to_string())?;
    let code = body.get("authorization_code").and_then(|value| value.as_str()).unwrap_or("");
    let verifier = body.get("code_verifier").and_then(|value| value.as_str()).unwrap_or("");
    if code.is_empty() || verifier.is_empty() {
        return Ok(None);
    }
    let secret = exchange_authorization_code(code, verifier, "https://auth.openai.com/deviceauth/callback")?;
    Ok(Some(secret))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_hosts_reject_other_destinations() {
        assert!(require_request_url(ProviderKind::OpenaiCodex, "https://chatgpt.com/backend-api/codex/responses").is_ok());
        assert!(require_request_url(ProviderKind::OpenaiCodex, "https://evil.example/backend-api/codex/responses").is_err());
        assert!(require_request_url(ProviderKind::OpenaiCodex, "http://chatgpt.com/backend-api/codex/responses").is_err());
        assert!(require_request_url(ProviderKind::OpenaiCodex, "https://chatgpt.com/backend-api/other").is_err());
        assert!(require_request_url(ProviderKind::Custom, "https://chatgpt.com/backend-api/codex/responses").is_err());
    }

    fn codex_provider(secret: &str) -> Provider {
        let mut provider = Provider::new("ChatGPT", CODEX_BASE, secret, ApiStyle::Responses);
        provider.kind = ProviderKind::OpenaiCodex;
        provider.id = ID_CODEX.to_string();
        provider
    }

    #[test]
    fn codex_requests_use_responses_and_hide_the_conversation_id() {
        let secret = serde_json::json!({ "access_token": "access-token-value", "refresh_token": "r" });
        let provider = codex_provider(&secret.to_string());
        let prepared = prepare(&provider, " gpt-5.5 ", Some("conversation-42")).unwrap();
        assert_eq!(prepared.api_base, CODEX_BASE);
        assert_eq!(prepared.style, ApiStyle::Responses);
        assert_eq!(prepared.wire_model, "gpt-5.5");
        assert_eq!(prepared.token, "access-token-value");
        assert!(prepared.no_redirect);
        assert!(prepared.extra_headers.iter().any(|(name, value)| name == "originator" && value == "gopher"));
        let session = prepared
            .extra_headers
            .iter()
            .find(|(name, _)| name == "session_id")
            .map(|(_, value)| value.clone())
            .unwrap();
        assert!(!session.contains("conversation-42"));
        assert_eq!(session.len(), 64);
    }

    #[test]
    fn pkce_state_mismatch_is_rejected() {
        let request = "GET /auth/callback?code=abc&state=wrong HTTP/1.1\r\n";
        assert!(callback_code(request, "expected-state-value").is_err());
        let ok = "GET /auth/callback?code=abc&state=expected-state-value HTTP/1.1\r\n";
        assert_eq!(callback_code(ok, "expected-state-value").unwrap(), "abc");
    }

    #[test]
    fn browser_noise_does_not_end_the_callback_wait() {
        assert!(!is_callback_request("GET /favicon.ico HTTP/1.1\r\n"));
        assert!(!is_callback_request(""));
        assert!(!is_callback_request("GET /auth/callbackx?code=a HTTP/1.1\r\n"));
        assert!(is_callback_request("GET /auth/callback?code=a&state=b HTTP/1.1\r\n"));
    }

    #[test]
    fn callback_reports_openai_error_description() {
        let request =
            "GET /auth/callback?error=access_denied&error_description=User%20cancelled&state=s HTTP/1.1\r\n";
        let error = callback_code(request, "s").unwrap_err();
        assert!(error.contains("User cancelled"));
    }

    #[test]
    fn authorize_url_matches_the_codex_client_registration() {
        let url = authorize_url("http://localhost:1455/auth/callback", "challenge", "state");
        let parsed = reqwest::Url::parse(&url).unwrap();
        let pairs: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(pairs["redirect_uri"], "http://localhost:1455/auth/callback");
        assert_eq!(pairs["scope"], "openid profile email offline_access");
        assert_eq!(pairs["code_challenge_method"], "S256");
        assert_eq!(pairs["client_id"], CODEX_CLIENT_ID);
        assert!(!pairs.contains_key("originator"));
    }

    #[test]
    fn redact_removes_secrets_from_errors() {
        let text = redact("failed bearer sk-live-secret-value", &["sk-live-secret-value"]);
        assert!(!text.contains("sk-live"));
        assert!(text.contains("[redacted]"));
    }

    #[test]
    fn a_plain_api_key_is_not_a_codex_sign_in() {
        assert!(prepare(&codex_provider("sk-not-a-codex-session"), "gpt-5.5", None).is_err());
    }

    #[test]
    fn codex_catalog_advertises_only_shared_reasoning_efforts() {
        let body = json!({
            "models": [
                {
                    "slug": "gpt-6-luna",
                    "priority": 1,
                    "visibility": "list",
                    "use_responses_lite": true,
                    "supported_reasoning_levels": [
                        { "effort": "low" },
                        { "effort": "Medium" },
                        { "effort": "high" },
                        { "effort": "xhigh" },
                        { "effort": "max" },
                        { "effort": "ultra" },
                        { "effort": "low" }
                    ]
                },
                {
                    "slug": "hidden-model",
                    "visibility": "hidden",
                    "supported_reasoning_levels": [{ "effort": "low" }]
                },
                {
                    "slug": "gpt-6-luna",
                    "priority": 9,
                    "supported_reasoning_levels": [{ "effort": "low" }]
                },
                {
                    "slug": "gpt-5.5",
                    "priority": 2,
                    "use_responses_lite": false,
                    "supports_reasoning_summary_parameter": false,
                    "supported_reasoning_levels": [{ "effort": "high" }]
                },
                { "slug": "plain", "priority": 3 },
                {
                    "slug": "ultra-only",
                    "priority": 4,
                    "supported_reasoning_levels": [
                        { "effort": "xhigh" },
                        { "effort": "ultra" }
                    ]
                }
            ]
        });
        let models = codex_catalog_models(&body);
        let names: Vec<_> = models.iter().map(|model| model.model.as_str()).collect();
        assert_eq!(names, ["gpt-6-luna", "gpt-5.5", "plain", "ultra-only"]);

        let luna = &models[0];
        assert!(luna.thinking_supported);
        assert_eq!(luna.thinking_control.as_deref(), Some("reasoning"));
        assert_eq!(luna.thinking_efforts, ["low", "medium", "high", "max"]);
        assert!(!luna.thinking_can_disable);
        assert_eq!(luna.reasoning_summary.as_deref(), Some("detailed"));
        assert_eq!(luna.reasoning_context.as_deref(), Some("all_turns"));

        let classic = &models[1];
        assert_eq!(classic.thinking_efforts, ["high"]);
        assert!(classic.reasoning_summary.is_none());
        assert!(classic.reasoning_context.is_none());

        assert!(!models[2].thinking_supported);
        assert!(models[2].thinking_control.is_none());
        assert!(models[2].thinking_efforts.is_empty());
        assert!(models[2].reasoning_summary.is_none());
        assert!(!models[3].thinking_supported);
    }
}
