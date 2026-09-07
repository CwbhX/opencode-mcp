# Compatibility

Inventory of the MCP surface against the OpenCode HTTP contract used by this
bridge. Prepared for **opencode-mcp 1.12.0**.

This is **not** a live-certification report. Rows record the request the bridge
sends, the runtime capability required, which named tests exist, and what has
actually been verified.

## Evidence labels

| Label | Meaning |
|---|---|
| Source-confirmed | Bridge code matches the inspected OpenCode ~1.18 session/prompt/status/question contract. |
| Layer A | Unit/contract tests against repository modules (serializers, status reducer, task manager, transport). |
| Layer B | HTTP wire tests against a strict local fake (`tests/integration/mcp-wire.test.ts`). Not a real OpenCode process. |
| Layer C | Real tagged OpenCode process. Opt-in: `OPENCODE_MCP_SERVER_TEST=1`. Stubbed; not implemented in this release. |
| Layer D | Live model smoke. Opt-in: `OPENCODE_MCP_LIVE_TEST=1`. Not run by default. |
| Not exercised | No automated pass in this checkout for that row. A skip is not a pass. |

**Comparison target:** OpenCode stable **v1.18.29** (source + implementation brief). Running `/global/health` and `/doc` can differ from `opencode --version` if another process is bound to the port.

## Behavioral contract (honest)

- **`opencode_fire`** is accepted dispatch only. It returns a handle:
  `jobId`, `sessionId`, `requestMessageID`, `directory`. The model may still
  be running. Use `opencode_check` / `opencode_wait` with that handle
  (`jobId`, or `sessionId` + `requestMessageID` + `directory`).
- **Idle or a missing `/session/status` entry is not Done.** Absence is
  untracked/indeterminate, not success.
- **Do not set global `permission: "allow"`** as the default headless
  workaround. List pending requests and reply explicitly
  (`once` / `always` / `reject`) or use scoped OpenCode permission rules.
- **Auto-started OpenCode is an SDK child process on loopback**, not an
  in-process engine. Jobs from `fire` do **not** survive this MCP process
  exiting. Use a separately managed `opencode serve` for shared or long-lived
  work.
- **Auto-start** runs only when the health probe is **connection-refused**
  **and** the configured host is loopback (`127.0.0.1`, `localhost`, `::1`).
  HTTP **401/403 does not spawn** another server.
- **`directory` must be an existing absolute path.** `~` and relative paths
  are rejected. Literal `%` path segments are rejected as unsupported. Omitted
  `directory` uses the OpenCode server's project context, not this MCP
  process's cwd.
- **Model identity is a full pair.** A single `providerID` or `modelID` is
  rejected and is not merged with defaults. There is no paid-model fallback
  and no hardcoded free-model list. Discover providers with `opencode_setup`
  / `opencode_provider_list`.
- **`OPENCODE_REQUIRE_EXPLICIT_MODEL=true`** requires an explicit or
  configured full pair. **`OPENCODE_ALLOWED_MODELS`** is a JSON array of
  `provider/model` strings (for example
  `["opencode/muse-spark-1.3-contributor-free"]`).
- **Question tools exist:** `opencode_question_list`,
  `opencode_question_reply`, `opencode_question_reject`.
- **TUI tools need an attached TUI.** Headless `opencode serve` without a TUI
  will fail those calls.
- **Mutating HTTP calls are not retried.** A dropped response after a POST
  is ambiguous acceptance (`safeToResubmit: false`), not a signal to replay.
- **`readOnlyHint` is not a sandbox.** A `plan` agent is not guaranteed
  write-incapable unless OpenCode permissions actually block writes.

## Prompt / command payload shapes (~1.18)

| Operation | Endpoint | Request shape | Response |
|---|---|---|---|
| Create session | `POST /session` | Optional `title` (and other validated creation fields) | Session with `id` |
| Sync prompt | `POST /session/{id}/message` | `parts`, optional `messageID`, `model: {providerID, modelID}`, top-level `variant`, `agent`, `system`, `noReply` | Prompt response (waits) |
| Async prompt | `POST /session/{id}/prompt_async` | Same prompt payload | **204 = dispatch accepted**, not task succeeded |
| Slash command | `POST /session/{id}/command` | `command`, `arguments`, optional `model` as `"provider/model"` string, top-level `variant`, `agent`, `messageID` | Command response |
| Shell | `POST /session/{id}/shell` | `command`, required `agent`, optional model **object**; `variant` is rejected by the bridge | Shell response |
| Summarize | `POST /session/{id}/summarize` | `providerID`, `modelID`, optional `auto`; `variant` is rejected by the bridge | Boolean / accepted |
| Status | `GET /session/status` | Directory header | Map of `idle` / `busy` / `retry`; **absence ≠ success** |
| Messages | `GET /session/{id}/message` | Optional `limit` query | Messages with `info` + `parts` |
| Permissions | `GET /permission` | Directory header | Pending requests |
| Permission reply | `POST /permission/{requestID}/reply` | `{ reply }` (`once` / `always` / `reject`); legacy session route only if the primary route is unambiguously missing | Boolean / accepted |
| Questions | `GET /question` | Directory header | Pending question requests |
| Question reply | `POST /question/{requestID}/reply` | `{ answers }` — array of selected-label arrays, one inner array per question, in order | Boolean / accepted |
| Question reject | `POST /question/{requestID}/reject` | No invented body | Boolean / accepted |

## Tool inventory

Registered count from `src/tools/*.ts`: **83 tools** (13 workflow + 3
question + 67 other), plus **10 resources** and **6 prompts**.

`directory` on every tool is sent as `x-opencode-directory` when valid.

| Tool / resource | Endpoint(s) | Request / response contract | Required capability | Test IDs | Verified version | Result / limitation |
|---|---|---|---|---|---|---|
| `opencode_setup` | `GET /global/health`, `GET /provider`, `GET /provider/auth`, `GET /project/current` | Read-only dashboard; no model mutation | Reachable OpenCode | START-01 (A), PACKAGE-02 | ~1.18.29 source | Discovers providers; does not invent a free-model list |
| `opencode_ask` | `POST /session`, `POST /session/{id}/message` | Prompt body via `buildPromptBody`; waits for sync response | Configured provider/model pair | MODEL-01 (A/B), MODEL-03 (A) | ~1.18.29 source + Layer B serializers | Sync wait; not a job handle |
| `opencode_reply` | `GET /session/{id}`, `POST /session/{id}/message` | Same prompt body; session/directory must match | Existing session + model pair | DIR-03 (A), MODEL-01 (A/B) | ~1.18.29 source | Rejects session/directory mismatch before prompt |
| `opencode_run` | `POST /session` (if needed), `POST /session/{id}/prompt_async`, then status/messages/events | One deadline for submit+wait; returns correlated result or block/timeout | Model pair; job registry in this MCP process | ASYNC-01/02 (A), DEADLINE-03 (A), JOB-* (A) | ~1.18.29 source + Layer A | Timeout does not abort server work; idle ≠ Done |
| `opencode_fire` | `POST /session` (if needed), `POST /session/{id}/prompt_async` | **204 accepted**; returns `jobId` / `sessionId` / `requestMessageID` / `directory` | Model pair; MCP process must stay up | ASYNC-01/02 (A/B), WIRE-01 (B), REPLAY-01 (A/B) | ~1.18.29 source + Layer B 204 | Handle only. Does not survive MCP exit |
| `opencode_check` | `GET /session/{id}`, `GET /session/status`, `GET /session/{id}/todo`, `GET /session/{id}/diff`, `GET /session/{id}/message` | Observe handle; session-only is untracked | Handle from fire/run, or recovery tuple | JOB-01/02/08/11 (A) | ~1.18.29 source | Idle/absent is not Done |
| `opencode_wait` | Same reads + event monitor | Wait until terminal, blocked, timed out, or cancelled | Same as check | DEADLINE-03/05 (A), BLOCK-01 (A) | ~1.18.29 source | Timeout ≠ abort; blocked is not a tool error |
| `opencode_conversation` | `GET /session/{id}/message` | Formatted history | Session exists | — | ~1.18.29 source | Read-only; not a completion signal |
| `opencode_sessions_overview` | `GET /session`, `GET /session/status` | List + status map | OpenCode | JOB-08 (A) | ~1.18.29 source | Status objects rendered; idle ≠ this-task Done |
| `opencode_context` | `GET /project/current`, `/path`, `/vcs`, `/config`, `/agent` | Combined snapshot | OpenCode + optional directory | DIR-04 (A) | ~1.18.29 source | Some inner GETs are best-effort |
| `opencode_review_changes` | `GET /session/{id}/diff` | Optional `messageID` query | Session | — | ~1.18.29 source | Read-only |
| `opencode_provider_test` | `GET /provider`, `POST /session`, `POST /session/{id}/message`, `DELETE /session/{id}` | Tests the requested or that provider's listed default — never another provider | Named provider + a model on it | MODEL-06 (A), MODEL-08 (A) | ~1.18.29 source | No paid fallback if the selected model is absent |
| `opencode_status` | `GET /global/health`, `/provider`, `/session`, `/vcs` | Dashboard | OpenCode | — | ~1.18.29 source | Read-only |
| `opencode_health` | `GET /global/health` | `{ healthy, version }` | OpenCode | START-01/03 (A) | ~1.18.29 source | 401 is auth failure, not "down" |
| `opencode_session_list` | `GET /session` | Session array | OpenCode | — | ~1.18.29 source | Scoped by directory header |
| `opencode_session_create` | `POST /session` | `{ title? }` | OpenCode | REPLAY-02 (A intent) | ~1.18.29 source | Mutation; no automatic replay |
| `opencode_session_get` | `GET /session/{id}` | Session object | Session exists | JOB-01 (A) | ~1.18.29 source | 404 is missing, not Done |
| `opencode_session_delete` | `DELETE /session/{id}` | Destructive | Session exists | — | ~1.18.29 source | Not live-tested against a user server |
| `opencode_session_update` | `PATCH /session/{id}` | `{ title? }` | Session exists | — | ~1.18.29 source | |
| `opencode_session_search` | `GET /session` | Client-side title filter | OpenCode | — | ~1.18.29 source | Not a server search index |
| `opencode_session_children` | `GET /session/{id}/children` | Child sessions | Session exists | — | ~1.18.29 source | |
| `opencode_session_status` | `GET /session/status` | Status map | OpenCode | JOB-08 (A) | ~1.18.29 source | Missing key ≠ success |
| `opencode_session_todo` | `GET /session/{id}/todo` | Todo list | Session exists | — | ~1.18.29 source | |
| `opencode_session_init` | `POST /session/{id}/init` | `{ messageID, providerID, modelID, variant? }` | Session + model | — | ~1.18.29 source | Slow; variant forwarded if provided |
| `opencode_session_abort` | `POST /session/{id}/abort` | Session-wide abort (not job-specific) | Session exists | — | ~1.18.29 source | Does not claim a specific job was aborted |
| `opencode_session_fork` | `POST /session/{id}/fork` | Optional `messageID` | Session exists | — | ~1.18.29 source | |
| `opencode_session_share` | `POST /session/{id}/share` | Public share | Session exists | — | ~1.18.29 source | **Not exercised** against a user server |
| `opencode_session_unshare` | `DELETE /session/{id}/share` | Unshare | Session exists | — | ~1.18.29 source | **Not exercised** |
| `opencode_session_diff` | `GET /session/{id}/diff` | Optional `messageID` | Session exists | — | ~1.18.29 source | |
| `opencode_session_summarize` | `POST /session/{id}/summarize` | `{ providerID, modelID, auto? }`; variant rejected | Model pair | MODEL-05 (A) | ~1.18.29 source | No `variant` field sent |
| `opencode_session_revert` | `POST /session/{id}/revert` | `{ messageID, partID? }` | Session exists | — | ~1.18.29 source | Destructive |
| `opencode_session_unrevert` | `POST /session/{id}/unrevert` | Empty body | Session exists | — | ~1.18.29 source | |
| `opencode_permission_list` | `GET /permission` | Pending requests | OpenCode | BLOCK-01/03 (A) | ~1.18.29 source | No auto-approval |
| `opencode_session_permission` | `POST /permission/{id}/reply`; fallback `POST /session/{id}/permissions/{id}` | `{ reply }` enum; legacy only if primary route is unambiguously missing | Pending request | BLOCK-04 (A intent) | ~1.18.29 source | Auth/timeout is **not** treated as "route missing" |
| `opencode_message_list` | `GET /session/{id}/message` | Optional `limit` query | Session exists | WIRE-01 GET query (B) | ~1.18.29 source + Layer B query | |
| `opencode_message_get` | `GET /session/{id}/message/{messageId}` | One message | Session exists | — | ~1.18.29 source | |
| `opencode_message_send` | `GET /session/{id}`, `POST /session/{id}/message` | `buildPromptBody`; sync wait | Session + model pair | MODEL-01 (A/B) | ~1.18.29 source + Layer B | `noReply` is injection, not a generated result (JOB-13) |
| `opencode_message_send_async` | `POST /session/{id}/prompt_async` | Same prompt body; 204; returns job handle | Session + model pair | ASYNC-02 (A), WIRE-01 (B) | ~1.18.29 source + Layer B | Prefer `opencode_wait` with the handle |
| `opencode_command_execute` | `POST /session/{id}/command` | `model` is `"provider/model"` string | Session | MODEL-02 (A/B) | ~1.18.29 source + Layer B | Fake/server **rejects** a model object |
| `opencode_shell_execute` | `POST /session/{id}/shell` | Model **object**; `variant` rejected | Session + `agent` | MODEL-05 (A) | ~1.18.29 source | |
| `opencode_question_list` | `GET /question` | Pending question requests | OpenCode | BLOCK-02 (A intent) | ~1.18.29 source | New in 1.12.0 |
| `opencode_question_reply` | `POST /question/{requestID}/reply` | `{ answers: string[][] }` in question order | Pending question | BLOCK-02 (A intent) | ~1.18.29 source | Do not invent answers to finish a wait |
| `opencode_question_reject` | `POST /question/{requestID}/reject` | No body | Pending question | — | ~1.18.29 source | |
| `opencode_find_text` | `GET /find?pattern=` | Regex search | Project directory | — | ~1.18.29 source | |
| `opencode_find_file` | `GET /find/file` | Fuzzy name query | Project directory | — | ~1.18.29 source | |
| `opencode_find_symbol` | `GET /find/symbol?query=` | Workspace symbols | Project + LSP | — | ~1.18.29 source | Needs LSP |
| `opencode_file_list` | `GET /file` | Path query | Project directory | DIR-01 (A) | ~1.18.29 source | |
| `opencode_file_read` | `GET /file/content?path=` | File content | Project directory | — | ~1.18.29 source | |
| `opencode_file_status` | `GET /file/status` | VCS file status | Git project | — | ~1.18.29 source | |
| `opencode_config_get` | `GET /config` | Config object | OpenCode | — | ~1.18.29 source | |
| `opencode_config_update` | `PATCH /config` | Partial merge | OpenCode | — | ~1.18.29 source | Do not use this to set global `permission: "allow"` as a default workaround |
| `opencode_config_providers` | `GET /config/providers` | Configured providers | OpenCode | — | ~1.18.29 source | |
| `opencode_provider_list` | `GET /provider` | Live provider list | OpenCode | PACKAGE-02 (A) | ~1.18.29 source | No stale hardcoded free-model catalog |
| `opencode_provider_models` | `GET /provider` | Models for one provider | Provider id | — | ~1.18.29 source | Discover at call time |
| `opencode_provider_auth_methods` | `GET /provider/auth` | Auth methods | OpenCode | — | ~1.18.29 source | |
| `opencode_provider_oauth_authorize` | `POST /provider/{id}/oauth/authorize` | Start OAuth | Interactive user | — | ~1.18.29 source | **Not exercised** (no real OAuth in tests) |
| `opencode_provider_oauth_callback` | `POST /provider/{id}/oauth/callback` | Callback payload | Interactive user | — | ~1.18.29 source | **Not exercised** |
| `opencode_auth_set` | `PUT /auth/{providerId}` | `{ type, key }` | Credentials | — | ~1.18.29 source | **Not exercised** against a user store |
| `opencode_tui_append_prompt` | `POST /tui/append-prompt` | `{ text }` | **Attached TUI** | — | conditional | Fails on headless server without TUI |
| `opencode_tui_submit_prompt` | `POST /tui/submit-prompt` | Empty | **Attached TUI** | — | conditional | Same |
| `opencode_tui_clear_prompt` | `POST /tui/clear-prompt` | Empty | **Attached TUI** | — | conditional | Same |
| `opencode_tui_execute_command` | `POST /tui/execute-command` | `{ command }` | **Attached TUI** | — | conditional | Same |
| `opencode_tui_show_toast` | `POST /tui/show-toast` | `{ message, title?, variant? }` | **Attached TUI** | — | conditional | Same |
| `opencode_tui_open_help` | `POST /tui/open-help` | Empty | **Attached TUI** | — | conditional | Same |
| `opencode_tui_open_sessions` | `POST /tui/open-sessions` | Empty | **Attached TUI** | — | conditional | Same |
| `opencode_tui_open_models` | `POST /tui/open-models` | Empty | **Attached TUI** | — | conditional | Same |
| `opencode_tui_open_themes` | `POST /tui/open-themes` | Empty | **Attached TUI** | — | conditional | Same |
| `opencode_path_get` | `GET /path` | Working path | OpenCode | — | ~1.18.29 source | |
| `opencode_vcs_info` | `GET /vcs` | Git info | Git project | — | ~1.18.29 source | |
| `opencode_instance_dispose` | `POST /instance/dispose` | Destructive instance shutdown | OpenCode | START-06 (A intent) | ~1.18.29 source | Not the same as exiting this MCP process |
| `opencode_agent_list` | `GET /agent` | Agents | OpenCode | — | ~1.18.29 source | `plan` is not a write sandbox |
| `opencode_command_list` | `GET /command` | Slash commands | OpenCode | — | ~1.18.29 source | |
| `opencode_lsp_status` | `GET /lsp` | LSP servers | OpenCode | — | ~1.18.29 source | |
| `opencode_formatter_status` | `GET /formatter` | Formatters | OpenCode | — | ~1.18.29 source | |
| `opencode_mcp_status` | `GET /mcp` | Nested MCP servers | OpenCode | — | ~1.18.29 source | |
| `opencode_mcp_add` | `POST /mcp` | `{ name, config }` | OpenCode | — | ~1.18.29 source | |
| `opencode_tool_ids` | `GET /experimental/tool/ids` | Experimental | OpenCode | — | experimental | May change |
| `opencode_tool_list` | `GET /experimental/tool` | `provider` + `model` query | OpenCode | — | experimental | May change |
| `opencode_log` | `POST /log` | `{ service, level, message, extra? }` | OpenCode | — | ~1.18.29 source | |
| `opencode_events_poll` | `GET /event` (SSE) | Collect for `durationMs` | OpenCode SSE | EVENT-01/03/04 (A) | ~1.18.29 source | **Directory header is not forwarded** on this SSE subscribe |
| `opencode_project_list` | `GET /project` | Known projects | OpenCode | — | ~1.18.29 source | |
| `opencode_project_init` | `GET /project/current` after mkdir | Absolute path; deny-list + realpath | Writable host path | DIR-04/06 (A) | ~1.18.29 source | Rejects `~`, relative, control bytes, system roots |
| `opencode_project_current` | `GET /project/current` | Active project | Directory header | — | ~1.18.29 source | |
| `opencode://project/current` | `GET /project/current` | JSON resource | OpenCode | — | ~1.18.29 source | |
| `opencode://config` | `GET /config` | JSON resource | OpenCode | — | ~1.18.29 source | |
| `opencode://providers` | `GET /provider` | JSON resource | OpenCode | — | ~1.18.29 source | Live list, not a cached free-model table |
| `opencode://agents` | `GET /agent` | JSON resource | OpenCode | — | ~1.18.29 source | |
| `opencode://commands` | `GET /command` | JSON resource | OpenCode | — | ~1.18.29 source | |
| `opencode://health` | `GET /global/health` | JSON resource | OpenCode | START-01 (A) | ~1.18.29 source | |
| `opencode://vcs` | `GET /vcs` | JSON resource | Git project | — | ~1.18.29 source | |
| `opencode://sessions` | `GET /session` | JSON resource | OpenCode | — | ~1.18.29 source | |
| `opencode://mcp-servers` | `GET /mcp` | JSON resource | OpenCode | — | ~1.18.29 source | |
| `opencode://file-status` | `GET /file/status` | JSON resource | Git project | — | ~1.18.29 source | |

## Layer status for this release

| Layer | How to run | Status |
|---|---|---|
| A — unit/contract | `npm run test:unit` | Implemented (serializers, transport, task manager, status, directory, startup probe) |
| B — HTTP wire | `npm run test:wire` | Implemented against a local fake via `OpenCodeClient` (not a spawned MCP stdio process) |
| C — real OpenCode | `OPENCODE_MCP_SERVER_TEST=1 npm run test:server` | Stub; skips unless opt-in |
| D — live model | `OPENCODE_MCP_LIVE_TEST=1 npm run test:live` | Script skips unless opt-in + full provider/model pair; uses a scratch directory |

G1/G2 (A+B) can pass without proving the user's Mac, account, or Zen model.
A skipped Layer C/D test is not a compatibility certification.
