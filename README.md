# <img src="assets/browser-favicon.png" alt="" width="36" height="36"> Gopher

A local, open source LLM workspace built with TypeScript.

Connect OpenAI-compatible, Anthropic Messages, or Responses providers, local or cloud. Gopher does not include an inference engine.

- Chats, projects, profiles, Loops, memory, model pins, search, drafts, exports, and Ghost sessions
- Streaming answers, reasoning, live reconnection, cancellation, editing, and branching
- Agent tools with approvals, steering, web research, browser control, files, terminal sessions, and custom skills
- Image attachments and offline OCR, plus PDF and text extraction
- Optional passphrase encryption for chats, preferences, provider credentials, skills, and saved diagnostics
- Native Electron desktop app and a secured, loopback-only browser server

## Run from source

Install **Node.js 24.7 or later**, npm, and Git. Linux and macOS also require a
C/C++ compiler, make, and Python 3 for native dependencies. On macOS, install the
Xcode Command Line Tools. Then:

```sh
npm ci
npm run build
npm run desktop
```

For a browser window:

```sh
npm start -- --browser
```

For a server without opening a window:

```sh
npm start -- --headless
```

The default URL is `http://gopher.localhost:3930`. `http://127.0.0.1:3930` also works. Browser-control tools use an installed Chrome, Chromium, or Edge; set `GOPHER_BROWSER_PATH` to choose an executable.

The lockfile pins dependencies and explicitly approves native dependency installation scripts. `npm run desktop` installs Electron's binary when needed; when launching the Electron CLI directly, first run `node node_modules/electron/install.js`. `fs-ext` must compile on Unix for exclusive data locks, even though npm classifies it as optional. `node-pty` also compiles when no prebuilt binary matches your platform and Node.js version; Windows then requires Python 3 and Visual Studio C++ Build Tools.

Linux desktop sessions require Chromium's namespace sandbox. On Ubuntu 24.04 or
later with restricted unprivileged user namespaces, an administrator must permit
`userns` for the installed Electron executable through an AppArmor profile. See
[Ubuntu's executable-specific profile guidance](https://documentation.ubuntu.com/release-notes/24.04/#unprivileged-user-namespace-restrictions).
The executable is `node_modules/electron/dist/electron` inside the source checkout
or active release directory; update the profile when its path changes. Production
launches keep sandboxing enabled.

| Option | Behavior |
| --- | --- |
| `--browser` | Open the default browser |
| `--headless` | Run without opening a window |
| `--bind ADDR` | Choose a loopback address; port `0` selects an available port |
| `--config PATH` | Read configuration and store data beside this file |
| `--version` | Show this build's source commit |

`GOPHER_BIND` supplies the bind address when the CLI does not. Non-loopback binds are rejected.

## Install

The platform installers build a pinned master commit in a new release directory and switch the launcher only after a successful build and native dependency checks. They require Node.js 24.7+, npm, and Git; Unix installers also use curl and the native build tools listed above. A missing or incompatible native dependency leaves the current release active.

```powershell
# Windows
irm https://raw.githubusercontent.com/jacobzymet/gopher/master/install.ps1 | iex
```

```sh
# macOS
curl -fsSL https://raw.githubusercontent.com/jacobzymet/gopher/master/install-macos.sh | sh
# Linux
curl -fsSL https://raw.githubusercontent.com/jacobzymet/gopher/master/install-linux.sh | sh
```

Use `GOPHER_INSTALL_DIR` or `--dir DIRECTORY` for a different launcher location. Windows supports `--no-path`. Settings → App checks master and can build and restart a compatible TypeScript update. Failed builds leave the installed app available; previous release directories remain for recovery.

## Existing data

Gopher reads existing configuration and storage formats, including Argon2id/AES-256-GCM encrypted files. Keep a backup when moving between application versions. An exclusive data-directory lock prevents concurrent writers.

| OS | Default data directory |
| --- | --- |
| Windows | `%APPDATA%\gopher\` |
| macOS | `~/Library/Application Support/gopher/` |
| Linux | `~/.config/gopher/` |

`config.toml` stores appearance, bind, and plaintext provider settings. `chats.json`, `preferences.json`, and `chat-skills/skills.json` store conversations, preferences, and custom skills. When encryption is enabled, these files are protected in place, provider credentials move into `provider-tokens.json`, and `encryption.json` holds the key-derivation metadata. Encryption changes use a recoverable journal.

```toml
active_provider_id = "local"

[ui]
host = "127.0.0.1"
port = 3930
theme = "dark"

[data]
storage = "disk"

[[providers]]
id = "local"
name = "Ollama"
base = "http://127.0.0.1:11434/v1"
api_style = "openai"
token = ""
```

Configure providers, search backends, custom skills, appearance, and other capabilities in Settings. ChatGPT supports browser sign-in, device-code sign-in, and explicitly confirmed local Codex-session import. A chat's manual model selection overrides the default until **Use default** is selected.

## Everyday controls

| Shortcut | Action |
| --- | --- |
| Ctrl/⌘ K | Search saved chats/projects or type `>` for actions |
| Ctrl/⌘ F | Find text in the current conversation |
| Ctrl/⌘ Shift O | Start a chat |
| Ctrl/⌘ , | Open Settings |

Drafts restore independently for each chat and project. Ghost sessions stay temporary. The conversation menu exports Markdown without attachment bytes, credentials, or tool payloads. Profiles and projects constrain past-chat retrieval; Ghost sessions cannot retrieve saved chats.

Agent file tools stay within the selected workspace. Bounded file reads can resume using byte offsets. Patch validation completes before writing, and unrelated edits are preserved. Read-only calls run in batches of up to eight; mutations and browser actions retain order.

Terminal commands continue through `wait_terminal` without relaunching the process. Sessions are scoped to their conversation and workspace, expire after 30 idle minutes, and retain bounded output with an explicit omission marker. Initial wait is separate from process lifetime.

The agent reserves context for tool definitions and responses, archives complete older assistant/tool exchanges, and preserves user/system/developer instructions. Context comes from the selected model, `GOPHER_AGENT_CONTEXT_TOKENS`, or an explicit request override. If protected input cannot fit, the request fails clearly instead of silently truncating instructions.

## Privacy and diagnostics

Encryption uses Argon2id and authenticated AES-256-GCM with purpose-bound data. The passphrase is never stored. Locking cancels requests, terminates terminals, closes isolated browser contexts, clears live buffers, and removes the session key. Data writes are atomic, reject symlinks/hardlinks, and use private OS permissions. Windows grants access to the current user and LocalSystem.

Encryption protects stored application data. It does not protect workspace files, previously copied plaintext, OS backups, or a compromised logged-in account. Forgotten passphrases cannot be recovered.

Diagnostic logging is off by default. Settings → Logs captures redacted browser/server/provider/tool events and timing milestones. Saved diagnostics require encryption; otherwise the bounded log stays in memory. Locking clears the live buffer.

Licensed under the [MIT License](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md).
