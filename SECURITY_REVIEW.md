# Security review — 2026-10-24

Reviewed the TypeScript server, agent tools, browser client, Electron shell,
storage/encryption, authentication, updates/installers, dependencies and CI.
Corrected Windows profile discovery to retain the original `gopher/config`
profile when a newer build has also created a root profile. Earlier filesystem
checks used an isolated AppData view and did not verify the user's live data.

## Findings addressed

| Finding | Change and evidence |
| --- | --- |
| Medium: an empty root profile could hide the original Windows archive | Prefer the original populated `gopher/config` profile, retaining explicit `--config` overrides and leaving both locations in place. Regression covers an encrypted original archive alongside an empty root chat file. |
| High: agent browser could bootstrap Gopher's own authenticated session and bypass tool capability/approval boundaries | Block app origins in browser routing; mark agent requests at the transport layer and reject them before cookie issuance, including redirects. Disable service workers to prevent interception bypasses. Real-browser regressions cover direct navigation, fetch, frames, popups and redirects. |
| High: Electron 44.3.0 has published security advisories | Pin 44.9.3 in the manifest, lockfile and installation-script policy. The resolved dependency audit reports zero advisories. Add a high-severity dependency audit to CI. See the [Electron advisory](https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9). |
| Medium: agent Chromium launched without its OS sandbox by default | Explicitly enable Chromium sandboxing. A real-browser check inspects the launched command line. Linux CI configures namespace permission before browser tests. |
| Medium: incomplete IPv6 SSRF filtering | Refuse translation, tunnelling, deprecated local, documentation and special-purpose IPv6 ranges while retaining ordinary public IPv6 and validated IPv4-mapped addresses. Literal and DNS-answer regressions verify rejection before transport. Based on the [IANA registry](https://www.iana.org/assignments/iana-ipv6-special-registry/). |
| Medium: terminal resource limits could be bypassed or applied too late | Limit WebSocket frames before buffering a complete message, disconnect slow readers, and recheck PTY/command capacity immediately before spawning after asynchronous setup. Tests cover oversized frames and concurrent per-conversation/global process limits. |
| Medium: malformed OAuth callback URL could reject an async HTTP handler without being caught | Return HTTP 400 for malformed URLs and keep the callback server available. Regression sends an invalid absolute URL followed by a valid callback path with invalid state. |

## Verification

- `npm test`: 204 passed, 6 skipped; skipped checks require Unix/macOS.
- `GOPHER_E2E=1 npm run test:ui`: 260 passed, no skips. Includes actual
  sanitizer/XSS checks, offline OCR, storage/encryption lock and terminal revocation.
- `npm run typecheck` and `npm run build`: passed.
- Final security-focused browser integration rerun: 11 passed.
- Electron 44.9.3: official binary archive SHA-256 verified against the pinned
  package checksums; installed binary reports `v44.9.3`. Both native desktop
  smoke checks passed (new server and existing-server reuse/shutdown).
- `npm audit --include=dev --json`: zero reported vulnerabilities in the updated lockfile.
- Reviewed authentication/Host/Origin checks, credential masking, encryption and
  journal recovery, private-file/link protections, workspace confinement, tool
  approvals, retrieval scope, DNS pinning/redirects, process cleanup and update pinning.
- Tracked-source scan found no matches for common private-key and provider-token patterns.

Logs are under `output/security-*.log` and `output/security-npm-audit-final.json`.

## Limits and activation

The Electron package and binary are updated to 44.9.3. The user closed the running
app to release its old runtime files before replacement; native desktop verification
used the updated executable. Those checks ran in an isolated filesystem view;
they did not establish that the user's live chats or background had been restored.
Subsequent inspection through the running desktop and Windows Explorer confirmed
that the live root profile was empty while the original nested archive remained.
After the user restarted and unlocked the desktop, its live API confirmed the
original profile path, enabled and unlocked encryption, saved conversations and
messages, and a saved background image. Windows Explorer also confirmed a sibling
backup of the original profile. No archive or encryption metadata is replaced by
this path fix. All ten focused profile and large-archive recovery tests, the build,
and type checking passed.

Linux/macOS behavior still needs the repository's platform CI; local verification
was on Windows. This review does not certify the app against every possible attack.
Terminal tools run with the user's OS privileges, and authorized provider/browser
activity can transmit data. Workspace checks do not isolate a compromised OS account.

The vendored DOMPurify 3.4.16 [shadow-root template advisory](https://github.com/cure53/DOMPurify/security/advisories/GHSA-cg2g-xh64-v4q7)
does not have a reachable configuration here: the application sanitizes HTML strings,
does not enable `SAFE_FOR_TEMPLATES`/DOM-returning modes, and does not evaluate
sanitized output as templates. Existing DOMPurify and KaTeX security regressions pass.
