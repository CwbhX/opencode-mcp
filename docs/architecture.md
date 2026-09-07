# Architecture

## Overview

opencode-mcp is a **stdio-based MCP server** that bridges MCP clients to the OpenCode headless HTTP API.

```
┌─────────────┐     stdio      ┌───────────────┐     HTTP      ┌─────────────────────────┐
│  MCP Client  │ <────────────> │  opencode-mcp  │ <──────────> │  OpenCode Server        │
│  (Claude,    │   JSON-RPC     │  (this package) │   REST API   │  (SDK child on loopback │
│   Cursor)    │                │                 │              │   or external `opencode │
│              │                │                 │              │   serve` you launched)  │
└─────────────┘                └───────────────┘              └─────────────────────────┘
```

## Project Structure

```
src/
├── index.ts              Main entry point — creates server, registers everything
├── server-manager.ts     Classified health + loopback SDK-child auto-start
├── client.ts             HTTP client (no mutation replay)
├── http-transport.ts     204 / auth / deadline / retry-class
├── task-manager.ts       prompt_async submit + job correlation
├── task-status.ts        Evidence-to-status reducer (idle ≠ Done)
├── model-selection.ts    Endpoint-specific model serializers
├── model-variants.ts     Per-model thinking/effort catalog keys
├── request-context.ts    Absolute directory + session identity
├── event-monitor.ts      Scoped SSE; ready only on server.connected
├── typed-outcome.ts      Typed assistant/provider/server-auth errors
├── helpers.ts            Response formatting + tool annotation constants
├── resources.ts          MCP Resources (10 browseable data endpoints)
├── prompts.ts            MCP Prompts (6 guided workflow templates)
└── tools/
    ├── workflow.ts       High-level workflow tools (13) — start here
    ├── session.ts        Session lifecycle management (20)
    ├── message.ts        Message/prompt operations (6)
    ├── question.ts       Pending user questions (3)
    ├── file.ts           File and search operations (6)
    ├── tui.ts            TUI remote control (9, need attached TUI)
    ├── config.ts         Configuration management (3)
    ├── provider.ts       Provider and authentication (6)
    ├── misc.ts           System, agents, LSP, MCP, logging (12)
    ├── events.ts         SSE event polling (1)
    ├── global.ts         Health check (1)
    └── project.ts        Project operations (3) — list, init, current
```

## Three MCP Primitives

| Primitive | Count | Purpose |
|---|---|---|
| **Tools** | 83 | Actions the LLM can take (13 workflow + 3 question + 67 other) |
| **Resources** | 10 | Data the LLM can browse |
| **Prompts** | 6 | Guided multi-step workflows |

## Key Design Decisions

### Layered Tool Architecture

Tools are in two layers:

- **Low-level** — 1:1 mapping to OpenCode API endpoints (session, message, file, etc.)
- **Workflow** — Composite operations that combine multiple calls (`opencode_ask`, `opencode_run`, `opencode_fire`, etc.)

The workflow layer reduces tool calls. `opencode_ask` is a sync prompt.
`opencode_run` / `opencode_fire` submit through `/prompt_async`. `fire`
returns an accepted handle (`jobId`, `sessionId`, `requestMessageID`,
`directory`); `check` / `wait` observe that handle. Idle is not Done.
Sync and async turns on the same session share a local lease.

### Tool Annotations

Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`) so clients can make informed decisions about safety. Read-only tools like `opencode_check` and `opencode_context` are annotated as safe; destructive tools like `opencode_instance_dispose` are flagged.

### Smart Response Formatting

Raw API responses are deeply nested JSON. The `helpers.ts` module transforms these into human-readable text:

- Message parts -> extracted text, tool call summaries
- Diffs -> formatted with file paths, add/delete counts
- Session lists -> bullet-point format with titles and IDs
- Large responses -> auto-truncated at 50K characters

### Robust HTTP Client

`OpenCodeClient` handles:

- **Observational-read retry** — Bounded backoff for GET 429/502/503/504
- **No mutation replay** — POST/PUT/PATCH/DELETE are not retried. A dropped
  or 5xx mutating response is `AmbiguousAcceptanceError` (`safeToResubmit: false`)
- **Error categorization** — `OpenCodeError` with `.isTransient`, `.isNotFound`, `.isAuth`
- **204 No Content** — Returned as `undefined` without JSON parse (`/prompt_async`)
- **SSE streaming** — Async generator for Server-Sent Events
- **Directory validation** — Absolute existing directories only; `~` and
  relative paths are rejected. Sent as `x-opencode-directory`
- **Read reconnect** — Connection-refused GETs may probe/auto-start on
  loopback. A later 401/unhealthy probe is the error that surfaces. Auth
  failures never spawn. Jobs are not moved if reconnect would change the URL.

### Default Provider/Model

Tools that accept `providerID` and `modelID` resolve a **full pair** only:

1. **Explicit params** — both `providerID` and `modelID` on the call
2. **Env-var defaults** — both `OPENCODE_DEFAULT_PROVIDER` and `OPENCODE_DEFAULT_MODEL`
3. **Server selection** — only when neither pair is set, a nonempty
   `OPENCODE_ALLOWED_MODELS` is **not** set, and
   `OPENCODE_REQUIRE_EXPLICIT_MODEL` is not `true`

A single identifier is rejected and is not merged with a default. Empty or
whitespace identifiers are invalid, not “use defaults.” Optional
`OPENCODE_ALLOWED_MODELS` (JSON array of `provider/model` strings) rejects
pairs outside the list and cannot be bypassed by omitting the pair; the first
entry is not substituted. There is no paid fallback and no hardcoded free-model
catalog.

### Thinking / effort variants

`variant` is a separate **top-level** field on prompt and command requests
(not nested inside `model`). Keys come from that model's OpenCode catalog
(`GET /provider` → `models[].variants`). The bridge lists **enabled** keys
via `opencode_provider_models` (`disabled: true` entries are omitted). MCP
schemas are static, so they cannot enumerate live keys. Init, summarize, and
shell reject `variant`.

### Auto-Start

On startup, the MCP probes `OPENCODE_BASE_URL/global/health`:

- **Healthy** — attach; do not spawn.
- **Connection refused** on loopback — `createOpencodeServer()` starts an
  OpenCode **SDK child process**. This is not an in-process engine.
  `opencode_fire` jobs do not survive this MCP process exiting.
- **401/403, HTML, timeout, TLS/DNS, generic `fetch failed`, remote host** —
  classified error; **do not spawn**.

Shutdown handlers (`SIGINT`, `SIGTERM`, `exit`) close an owned child. An
externally launched `opencode serve` is left running.

Concurrent `ensureServer()` calls are coalesced per `baseUrl`.

## Data Flow

### Tool Call

```
1. MCP Client sends JSON-RPC tool call via stdio
2. McpServer dispatches to registered handler
3. Handler builds HTTP request
4. OpenCodeClient makes HTTP call to OpenCode
5. Response formatted by helpers.ts
6. Formatted text returned as MCP tool result
7. McpServer sends JSON-RPC response via stdio
```

### Resource Read

```
1. Client requests resource by URI (e.g. opencode://health)
2. Handler fetches from OpenCode via HTTP
3. Data returned as resource content (JSON)
```

### SSE Events

```
1. opencode_events_poll opens SSE connection to /event
2. Events collected for specified duration
3. Connection closed, events formatted and returned
```

## Registration Pattern

Each tool group is a file exporting a `register*` function that receives `(server, client)`. New tool groups can be added without touching the entry point.

### Permission and question handling

In headless mode, OpenCode may pause a session for a permission or a user
question. That is a **blocked** result, not success. Do **not** set global
`permission: "allow"` as the default workaround.

- **`opencode_permission_list` / `opencode_session_permission`** — list and
  reply `once` / `always` / `reject`
- **`opencode_question_list` / `opencode_question_reply` /
  `opencode_question_reject`** — list and answer (selected-label arrays in
  question order) or reject

Never auto-approve or invent answers just to finish a wait. See
[compatibility.md](compatibility.md) for the endpoint inventory.
