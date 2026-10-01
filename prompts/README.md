# LLM prompts

Markdown sources for every prompt Gopher sends to a model.

The app loads these at compile time (`include_str!`) via `src/prompts/`. Chat UI templates are also served as `/prompts.js` so `chat.html` can assemble the system prompt without duplicating wording.

## Conventions

- One file ≈ one prompt (or one reusable fragment).
- `{{placeholders}}` are filled by the caller (`{{name}}`, `{{memory}}`, …).
- File body is the literal prompt text — no YAML frontmatter.
- Prefer editing here over hunting through Rust/JS string literals.

## Layout

| Path | Used by |
| --- | --- |
| `chat/` | System prompt pieces assembled in the chat UI (including loop identity and group collaboration) |
| `title/` | Auto-generated conversation titles |
| `agent/` | Agent mode / deep research system blocks & nudges |
| `tools/` | OpenAI-style tool `description` strings |

## Token Budget

Keep shared workflow rules in `agent/core.md`, capability policy in `agent/`,
and tool-specific semantics in `tools/`. Parameter types, defaults, and limits
belong in the tool schema; retain exceptions and examples that prevent misuse.
Do not shorten user instructions, memories, tool results, or skill contents.

Preserved rule coverage after consolidation:

| Behavior | Source |
| --- | --- |
| Independent batching, dependent ordering, stopping, final post-tool answer | `agent/core.md` |
| Search discovery, bounded reads, unique edits, validation, preservation of user changes | `agent/filesystem.md`, `tools/grep.md`, `tools/read-file.md` |
| Exact patch/replacement syntax, overwrite protection, limits and defaults | Tool descriptions and schemas in `src/agent/mod.rs` |
| Command review, successful exit, no restarts, cancellation, expiry and poll approval | `agent/terminal.md`, `tools/run-terminal.md`, `tools/wait-terminal.md` |
| Final image placement, public images and no raw base64 | `agent/images.md` |
| Search settings, freshness, snippets, quoted phrases, formats and pagination | Search/fetch capability prompts, tool descriptions and schemas |

Inspect assembled harness costs with:

```sh
cargo test --lib prompt_budget_report -- --ignored --nocapture
```

The report separates system text and tool schemas using the existing conservative
budget estimate. It excludes supplied user context and history; it is not an exact
model tokenizer count. Use provider usage for actual request totals.

For the Windows coding profile (filesystem, terminal, tool-history archive), this
consolidation reduced estimated system and schema overhead from about 5,398 to
4,195 tokens (22%). This excludes user context/history and any caching savings.

The UI sends the clock after stable instructions in a separate system message;
OpenAI-compatible requests merge leading system messages in order. Official
Anthropic streaming requests use five-minute automatic caching plus breakpoints
on the last tool and the first system block. Compatible endpoints and title
requests retain their prior format. Short prompts may not meet the model's minimum
cache length. Cache writes have a cost; savings depend on reuse.

Translated usage includes cache reads and writes in `prompt_tokens`, exposes
reads through `prompt_tokens_details.cached_tokens`, and forwards
`cache_creation_input_tokens` separately. Caching reduces repeated processing
costs, not the context size. See [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
