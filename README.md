# opencode-mcp

[![license](https://img.shields.io/github/license/CwbhX/opencode-mcp)](https://github.com/CwbhX/opencode-mcp/blob/main/LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![GitHub last commit](https://img.shields.io/github/last-commit/CwbhX/opencode-mcp)](https://github.com/CwbhX/opencode-mcp)

**Give any MCP client the power of [OpenCode](https://opencode.ai/).**

This repository is the **[CwbhX/opencode-mcp](https://github.com/CwbhX/opencode-mcp)** fork of [AlaeddineMessadi/opencode-mcp](https://github.com/AlaeddineMessadi/opencode-mcp). Install it from GitHub. `npx opencode-mcp` and `npm i -g opencode-mcp` pull the **npm registry** package, which is upstream, not this fork.

opencode-mcp is an MCP server that bridges your AI tools (Claude, Cursor, Windsurf, VS Code, etc.) to OpenCode's headless API. It lets your AI delegate real coding work — building features, debugging, refactoring, running tests — to OpenCode sessions that autonomously read, write, and execute code in your project.

**83 registered tools** (13 workflow + 3 question + 67 other) | **10 resources** | **6 prompts** | **Multi-project** | **Loopback auto-start**

## Why Use This?

- **Delegate coding tasks** — Tell Claude "build me a REST API" and it delegates to OpenCode, which creates files, installs packages, writes tests, and reports back.
- **Parallel work** — Fire off tasks to OpenCode and keep working. `opencode_fire` returns an accepted handle; `opencode_check` / `opencode_wait` observe that handle.
- **Any MCP client** — Works with Claude Desktop, Claude Code, Cursor, Windsurf, VS Code Copilot, Cline, Continue, Zed, Amazon Q, and any other MCP-compatible tool.
- **Attach or auto-start** — If nothing is listening on loopback, the bridge starts an OpenCode **SDK child process**. It does not spawn on HTTP 401, and it does not start a remote impersonator.

## Quick Start

Prefer a **separately managed** `opencode serve` on loopback, then point this
bridge at it with `OPENCODE_AUTO_SERVE=false`. See
[Recommended deployment](#recommended-deployment). Optional auto-start is only
a loopback fallback when the health probe is connection-refused.

> **Prerequisite:** [OpenCode](https://opencode.ai/) must be installed.
> `curl -fsSL https://opencode.ai/install | bash` or `npm i -g opencode-ai` or `brew install sst/tap/opencode`

**Claude Code:**

```bash
claude mcp add opencode -- npx -y github:CwbhX/opencode-mcp
```

**Claude Desktop / Cursor / Windsurf / Cline / Continue** (add to your MCP config):

```json
{
  "mcpServers": {
    "opencode": {
      "command": "npx",
      "args": ["-y", "github:CwbhX/opencode-mcp"]
    }
  }
}
```

That's it for a default attach. For long-lived work, start `opencode serve` first and set `OPENCODE_AUTO_SERVE=false` as in [Recommended deployment](#recommended-deployment).

> See [Configuration](docs/configuration.md) for all client configs (VS Code Copilot, Zed, Amazon Q, etc.) and environment variables.

## How It Works

```
MCP Client  <--stdio-->  opencode-mcp  <--HTTP-->  OpenCode Server
(Claude, Cursor, etc.)   (this package)            (SDK child on loopback,
                                                    or external opencode serve)
```

Your MCP client calls tools over stdio. This server translates them into HTTP requests to the OpenCode headless API. If the health probe is **connection-refused** on a **loopback** `OPENCODE_BASE_URL`, an OpenCode process is started via `@opencode-ai/sdk` (`createOpencodeServer`). That child is **not** an in-process engine: `opencode_fire` jobs do not survive this MCP process exiting. Use a separately managed `opencode serve` for shared or long-lived work. HTTP 401/403 does **not** spawn another server.

The `directory` parameter must be an **absolute existing directory**. `~` and relative paths are rejected. When valid, it is sent as `x-opencode-directory`. When omitted, OpenCode uses its own project context — not this MCP process's cwd.

## Key Tools

The registered tools are organized into tiers. Start with the workflow tools — they handle the common patterns in a single call.

### Workflow Tools (13) — Start Here

| Tool | What it does |
|---|---|
| `opencode_setup` | Check server health, providers, and project status. Use first. |
| `opencode_ask` | Create session + send prompt + get answer. One call. |
| `opencode_reply` | Follow-up message in an existing session |
| `opencode_run` | Submit via `/prompt_async` and wait on the job handle (idle is not Done) |
| `opencode_fire` | Accepted dispatch: returns `jobId` / `sessionId` / `requestMessageID` / `directory` |
| `opencode_check` | Observe that handle (prefer `jobId`). Idle/absent status is not success |
| `opencode_conversation` | Get formatted conversation history |
| `opencode_sessions_overview` | Quick overview of all sessions |
| `opencode_context` | Project + VCS + config + agents in one call |
| `opencode_review_changes` | Formatted diff summary for a session |
| `opencode_wait` | Poll an async session until it finishes |
| `opencode_provider_test` | Quick-test whether a provider is working |
| `opencode_status` | Health + providers + sessions + VCS dashboard |

### Recommended Patterns

**Quick question:**
```
opencode_ask({ prompt: "Explain the auth flow in this project" })
```

**Build something and wait:**
```
opencode_run({ prompt: "Add input validation to POST /api/users", maxDurationSeconds: 300 })
```

**Parallel background tasks:**
```
opencode_fire({ prompt: "Refactor the auth module to use JWT", providerID: "...", modelID: "..." })
→ accepted handle: jobId, sessionId, requestMessageID, directory
opencode_check({ jobId: "job_..." })
→ or sessionId + requestMessageID + directory; idle is not Done
```

### All Tool Categories

| Category | Count | Description |
|---|---|---|
| [Workflow](docs/tools.md#workflow-tools) | 13 | High-level composite operations |
| [Session](docs/tools.md#session-tools) | 20 | Create, list, fork, share, abort, revert, permissions |
| [Message](docs/tools.md#message-tools) | 6 | Send prompts, execute commands, run shell |
| [Question](docs/tools.md#question-tools) | 3 | List, reply to, or reject pending user questions |
| [File & Search](docs/tools.md#file--search-tools) | 6 | Search text/regex, find files/symbols, read files |
| [System](docs/tools.md#system--monitoring-tools) | 13 | Health, VCS, LSP, MCP servers, agents, logging |
| [TUI Control](docs/tools.md#tui-control-tools) | 9 | Remote-control an **attached** OpenCode TUI (conditional) |
| [Provider & Auth](docs/tools.md#provider--auth-tools) | 6 | List providers/models, set API keys, OAuth |
| [Config](docs/tools.md#config-tools) | 3 | Get/update configuration |
| [Project](docs/tools.md#project-tools) | 3 | List, inspect, and initialize projects |
| [Events](docs/tools.md#event-tools) | 1 | Poll real-time SSE events |

### Resources (10)

Browseable data endpoints — your client can read these without tool calls:

| URI | Description |
|---|---|
| `opencode://project/current` | Current active project |
| `opencode://config` | Current configuration |
| `opencode://providers` | Providers with models |
| `opencode://agents` | Available agents |
| `opencode://commands` | Available commands |
| `opencode://health` | Server health and version |
| `opencode://vcs` | Version control info |
| `opencode://sessions` | All sessions |
| `opencode://mcp-servers` | MCP server status |
| `opencode://file-status` | VCS file status |

### Prompts (6)

Guided workflow templates your client can offer as selectable actions:

| Prompt | Description |
|---|---|
| `opencode-code-review` | Review diffs from a session |
| `opencode-debug` | Step-by-step debugging workflow |
| `opencode-project-setup` | Get oriented in a new project |
| `opencode-implement` | Have OpenCode build a feature |
| `opencode-best-practices` | Setup, tool selection, monitoring, and pitfalls |
| `opencode-session-summary` | Summarize what happened in a session |

## Multi-Project Support

Every tool accepts an optional `directory` parameter to target a different project. It must be an absolute existing directory (`~` and relative paths are rejected). No restarts needed.

```
opencode_ask({ directory: "/home/user/mobile-app", prompt: "Add navigation" })
opencode_ask({ directory: "/home/user/web-app", prompt: "Add auth" })
```

Use `opencode_project_init` to scaffold a new project directory (or open a preexisting one) before the first call, so the OpenCode server registers it as a project:

```
opencode_project_init({ path: "/home/user/new-project" })
// → "Successfully initialized project directory at: /home/user/new-project"

opencode_run({ directory: "/home/user/new-project", prompt: "Set up a Vite + React app" })
```

## Environment Variables

All optional. Only needed if you've changed defaults on the OpenCode server.

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_BASE_URL` | `http://127.0.0.1:4096` | OpenCode server URL |
| `OPENCODE_SERVER_USERNAME` | `opencode` | HTTP basic auth username |
| `OPENCODE_SERVER_PASSWORD` | *(none)* | HTTP basic auth password (enables auth when set) |
| `OPENCODE_AUTO_SERVE` | `true` | Auto-start an SDK **child** on loopback only when the health probe is connection-refused. 401, HTML, TLS/DNS, and generic `fetch failed` do not spawn. |
| `OPENCODE_DEFAULT_PROVIDER` | *(none)* | Default provider ID; must be set together with `OPENCODE_DEFAULT_MODEL` |
| `OPENCODE_DEFAULT_MODEL` | *(none)* | Default model ID; must be set together with `OPENCODE_DEFAULT_PROVIDER` |
| `OPENCODE_REQUIRE_EXPLICIT_MODEL` | *(unset)* | When `true`, require an explicit or configured full provider/model pair |
| `OPENCODE_ALLOWED_MODELS` | *(unset)* | JSON array of allowed `provider/model` strings. A nonempty list cannot be bypassed by omitting the pair, and the first entry is not substituted. |

## Recommended deployment

Prefer a **separately managed** `opencode serve` and point this bridge at it:

```bash
opencode serve --port 4096 --hostname 127.0.0.1
```

Then run the MCP server with `OPENCODE_AUTO_SERVE=false` and
`OPENCODE_BASE_URL=http://127.0.0.1:4096`. Example env for an explicit pair:

```json
{
  "env": {
    "OPENCODE_AUTO_SERVE": "false",
    "OPENCODE_BASE_URL": "http://127.0.0.1:4096",
    "OPENCODE_DEFAULT_PROVIDER": "opencode",
    "OPENCODE_DEFAULT_MODEL": "muse-spark-1.3-contributor-free",
    "OPENCODE_REQUIRE_EXPLICIT_MODEL": "true",
    "OPENCODE_ALLOWED_MODELS": "[\"opencode/muse-spark-1.3-contributor-free\"]"
  }
}
```

In-memory `jobId` handles do not survive MCP exit; recover with `sessionId` +
`requestMessageID` + `directory`. Optional loopback auto-start is only for a
genuine connection refusal on `127.0.0.1` / `localhost` / `::1`.

Do not set global OpenCode `permission: allow` to make headless tests pass. Reply to permission and question blocks explicitly.

**Verified against OpenCode v1.18.29:** isolated tagged-server `session_create`
through MCP, and one live MCP `opencode_fire` → `opencode_wait` with
`opencode/muse-spark-1.3-contributor-free` (requested model matched observed;
`state=succeeded`). That is not a certificate of every tool, host OS, remote
filesystem, or later OpenCode version. Literal `%` path segments stay
rejected. The bridge allowlist does not constrain OpenCode subagents, title
generation, or config changed outside this MCP process.

## Development

```bash
git clone https://github.com/CwbhX/opencode-mcp.git
cd opencode-mcp
npm install
npm run build
npm start        # run the MCP server
npm run dev      # watch mode
npm test         # unit + integration files that are not opted-in C/D
npm run test:unit
npm run test:wire    # HTTP-client fake + real MCP stdio vs fake OpenCode (builds first)
npm run test:server  # Layer C: skips unless OPENCODE_MCP_SERVER_TEST=1
npm run test:live    # Layer D: skip without opt-in; missing config with opt-in fails
```

Tagged OpenCode integration (fails, does not skip, when opted in without the binary):

```bash
OPENCODE_MCP_SERVER_BINARY=/absolute/path/to/opencode-1.18.29 \
OPENCODE_MCP_SERVER_TEST=1 \
npm run test:server
```

### Smoke Testing

Opt-in live model smoke (scratch directory, not this repo):

```bash
OPENCODE_MCP_LIVE_TEST=1 \
OPENCODE_AUTO_SERVE=false \
OPENCODE_BASE_URL=http://127.0.0.1:4096 \
OPENCODE_DEFAULT_PROVIDER=opencode \
OPENCODE_DEFAULT_MODEL=muse-spark-1.3-contributor-free \
OPENCODE_REQUIRE_EXPLICIT_MODEL=true \
OPENCODE_ALLOWED_MODELS='["opencode/muse-spark-1.3-contributor-free"]' \
npm run test:live
```

A longer MCP stdio smoke against a running server:

```bash
npm run build && node scripts/mcp-smoke-test.mjs
```

## Documentation

- [Getting Started](docs/getting-started.md) — step-by-step setup
- [Configuration](docs/configuration.md) — env vars and all client configs
- [Tools Reference](docs/tools.md) — registered tools in detail
- [Compatibility](docs/compatibility.md) — endpoint inventory, test IDs, limitations
- [Resources](docs/resources.md) — 10 MCP resources
- [Prompts](docs/prompts.md) — 6 guided workflow templates
- [Examples](docs/examples.md) — real workflow examples
- [Architecture](docs/architecture.md) — system design and data flow

## References

- [OpenCode](https://opencode.ai/) | [OpenCode Docs](https://opencode.ai/docs/) | [OpenCode Server API](https://opencode.ai/docs/server/)
- [Model Context Protocol](https://modelcontextprotocol.io/)

## License

[MIT](LICENSE)
