# Compatibility

Inventory of the MCP surface against the OpenCode **v2** HTTP contract used
by this bridge. Prepared for **opencode-mcp 2.0.0**.

This release targets OpenCode v2 only. A v1 server is detected at probe
time and reported as incompatible — it is never silently driven with v2
requests. Verified against OpenCode **v2.0.28** (live binary); the wire
contract was taken from that server's `/openapi.json` plus live captures
of session, prompt, message, and SSE event payloads.

## Evidence labels

| Label | Meaning |
|---|---|
| Layer A | Unit/contract tests against repository modules (translation in `src/v2-adapt.ts`, client routing, status reducer, task manager, transport). |
| Layer B | Wire tests in `tests/integration/http-transport-wire.test.ts` plus MCP stdio tests in `tests/integration/mcp-stdio.test.ts` against a strict local fake speaking v2 shapes. Not a real OpenCode process. |
| Layer C | Real OpenCode v2 process. Opt-in: `OPENCODE_MCP_SERVER_TEST=1` and `OPENCODE_MCP_SERVER_BINARY=/absolute/path`. Missing opt-in is a skip, not a pass. Opt-in with a missing/non-v2 binary fails. |
| Layer D | Live model smoke through MCP `opencode_fire` → `opencode_wait`. Opt-in: `OPENCODE_MCP_LIVE_TEST=1`. Explicit opt-in with missing configuration fails. |
| Not exercised | No automated pass in this checkout for that row. A skip is not a pass. |

## Behavioral contract

- **OpenCode v2 is required.** Health is `GET /api/info` reporting
  `version: "2.x"`. The v2 web SPA answering HTML on unknown GET paths is
  classified incompatible, never healthy.
- **Authentication is mandatory.** v2 `serve` requires HTTP Basic auth
  (username `opencode`, password from `OPENCODE_SERVER_PASSWORD`). When
  the bridge auto-starts a server and no password is configured, it
  generates one and uses it for both the child process and the client.
  Against an externally managed server, set `OPENCODE_SERVER_PASSWORD`
  to that server's password. HTTP 401/403 never triggers a spawn.
- **Auto-start spawns `opencode serve` directly** (binary from
  `OPENCODE_BINARY` or PATH), only when the probe is connection-refused
  and the configured host is loopback. There is no `@opencode-ai/sdk`
  dependency anymore. Jobs from `opencode_fire` do not survive the MCP
  process exiting; use a separately managed `opencode serve` for
  long-lived work.
- **`directory` must be an existing absolute path.** It is sent as the
  v2 `location[directory]` query parameter (or as `location.directory`
  on session create). Session-scoped calls are located by the session
  itself. `~` and relative paths are rejected.
- **`opencode_fire` is accepted dispatch only.** It returns `jobId`,
  `sessionId`, `requestMessageID`, `directory`. The request message id
  is submitted as the v2 prompt `id`; assistants are correlated to it
  by message order. Use `opencode_check` / `opencode_wait` with the
  handle.
- **Absence from the active-session list is not Done.** Completion still
  requires a correlated terminal assistant (or an attributed error).
  A failed/interrupted v2 `idle` marker becomes an error result, never
  an empty success.
- **Model identity is a full pair**, applied per session via
  `POST /api/session/{id}/model` with a `Model.Ref`
  `{id, providerID, variant?}`. Variant keys come from the model's
  v2 `variants` array — discover with `opencode_provider_models`.
  There is no paid-model fallback and no hardcoded free-model list.
- **Questions are v2 forms.** `opencode_question_*` lists pending
  forms and maps positional label answers onto form field keys
  (resolving option labels to values). Rejecting cancels the form.
  Permission replies send `{decision}` to the session-scoped v2 route.
  Nothing is auto-approved to make a wait succeed.
- **Mutating HTTP calls are not retried.** A dropped response after a
  POST is ambiguous acceptance (`safeToResubmit: false`).
- **`readOnlyHint` is not a sandbox.**

## Wire translation map (internal path → v2)

Tools address stable internal paths; `src/client.ts` + `src/v2-adapt.ts`
translate to and from the v2 wire (`{data}` envelopes unwrapped,
sessions gain `directory`, messages become `{info, parts}`). Highlights:

| Internal | v2 wire |
|---|---|
| `GET /global/health` | `GET /api/info` → `{healthy, version}` |
| `POST /session/{id}/message` (sync) | set model/agent → `POST /api/session/{id}/prompt` → `POST /api/experimental/session/{id}/wait` → fetch messages |
| `POST /session/{id}/prompt_async` | set model/agent → `POST /api/session/{id}/prompt` (accepted dispatch) |
| `POST /session/{id}/command` | set model/agent → `POST /api/session/{id}/command {name, text}` → wait → last assistant |
| `POST /session/{id}/shell` | `POST /api/session/{id}/shell` → wait → shell message output |
| `POST /session/{id}/summarize` | set model → `POST /api/session/{id}/compact` |
| `POST /session/{id}/init` | set model → `POST /api/session/{id}/command {name:"init"}` |
| `POST /session/{id}/abort` | `POST /api/session/{id}/interrupt` |
| `GET /session/status` | synthesized from `GET /api/session/active` (running → busy) |
| `GET /session/{id}/message` | `GET /api/session/{id}/message?order=asc`, translated with synthesized `parentID` |
| `GET /provider` | synthesized from `GET /api/model` + `/api/provider` + `/api/integration` + `/api/model/default`; a provider counts as configured with an integration connection or an explicit provider entry |
| `GET /provider/auth` | integration methods |
| OAuth / `PUT /auth/{id}` | `POST /api/integration/{id}/connect/oauth[/{attempt}/complete]`, `.../connect/key` |
| `GET /permission`, reply | `GET /api/permission/request`; `POST /api/session/{id}/permission/{id}/reply {decision}` |
| `GET /question`, reply, reject | `GET /api/form`; `POST /api/session/{id}/form/{id}/reply {answer}`; `DELETE .../form/{id}` |
| `GET /find/file`, `/file`, `/file/content`, `/file/status` | `GET /api/fs/find`, `/api/fs/list`, `/api/fs/read/*` (raw text), `/api/vcs/status` |
| `GET /project[/current]`, `/path` | `GET /api/project`, `GET /api/location` |
| `GET/PATCH /config` | `GET /api/config` (config documents), `PATCH /api/experimental/config` (**only `{shell}` is accepted by v2**) |
| `GET /mcp`, `POST /mcp` | `GET /api/mcp`, `PUT /api/experimental/mcp/{server}` |
| `POST /instance/dispose` | `POST /api/location/reload` |
| `GET /event` (SSE) | `GET /api/event`, v2 `{id, type, data}` envelopes |
| revert / unrevert | `POST /api/session/{id}/revert/stage` + `/revert/commit`; `DELETE .../revert` |

## Not available on v2 (clear tool error, no wire call)

These tools remain registered so clients get an explicit
"not available on OpenCode v2" error instead of a silent failure:

- `opencode_tui_*` (9 tools) — v2 has no remote TUI-control endpoints.
- `opencode_session_todo` — no todo endpoint in v2.
- `opencode_session_share` / `opencode_session_unshare` — no share API.
- `opencode_find_text` (content grep) and `opencode_find_symbol` —
  v2 `fs/find` is file-name search only.
- `opencode_lsp_status`, `opencode_formatter_status`,
  `opencode_tool_ids`, `opencode_tool_list`, `opencode_log` — no
  corresponding v2 server endpoints.
- `opencode_config_update` for anything other than `{shell}` — the v2
  config patch endpoint accepts only the shell setting.

Everything else (83 tools total, 10 resources, 6 prompts) is mapped.

## Verification recorded for 2.0.0

- `npx tsc --noEmit` — clean.
- `npm run test:unit` — 595+ passed including new `tests/v2-client.test.ts`
  (message correlation, failed-idle errors, provider synthesis, form
  answers, sync/async prompt composites, unsupported-endpoint errors).
- `npm run test:wire` — v2 wire fake (7) + MCP stdio subprocess (7) pass.
- Layer C against the installed v2.0.28 binary — isolated serve + MCP
  `session_create` pass.
- Layer D live smoke — MCP `fire` → `wait` succeeded with
  requested = observed model (`openrouter/meta/muse-spark-open`) and
  `state=succeeded`.
- Manual MCP exercise against an auto-started v2.0.28: health, setup,
  ask, provider models (with variants), file list/read, session list,
  status, question/permission lists, resources all returned live data.

Known gaps: OAuth connect flows and form/permission replies are
covered by Layer A/B fakes, not exercised against a live OAuth
provider or a live blocked session in this pass. Shell results are
read back from session messages after the wait endpoint; very long
shell output follows the server's own truncation.
