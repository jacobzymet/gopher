# Hermes feature priorities

Reference: [Hermes Desktop](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/desktop.md)
and its [live work monitor](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/cli.md).

| Priority | Feature | Gopher status / next work |
| --- | --- | --- |
| Delivered | Process monitor | Per-chat list, expandable live logs, running/completed/failed/stopped status, elapsed time and Stop. Works independently of model polling, including after the agent reply finishes. |
| Next | Background completion events | Gopher has turn notifications. Add process exit notifications and an optional agent continuation so background builds/tests can report completion without repeated polling. |
| Next | Worker roster | Add real delegated workers with independent context, visible status/output, and individual steer/stop controls. Loops currently provide coordinated conversation flows. |
| Next | Workspace browser and preview rail | Add a file tree and file/HTML previews beside chat. Current file tools, workspace selection and image display provide the underlying access. |
| Later | Git changes panel | Show diffs and staged files, with commit/branch controls and agent handoff. Current Git work runs through terminal commands. |
| Later | Reliable scheduled jobs | Move recurring work into server-side scheduling with durable run history. Existing Loops coordinate chat turns in the client. |

Process logs are bounded in memory and scoped to their conversation. Persisted
process receipts across server restarts would extend the current completed-result viewer.
