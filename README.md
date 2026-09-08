# opencode-mcp

[![license](https://img.shields.io/github/license/CwbhX/opencode-mcp)](https://github.com/CwbhX/opencode-mcp/blob/main/LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![GitHub last commit](https://img.shields.io/github/last-commit/CwbhX/opencode-mcp)](https://github.com/CwbhX/opencode-mcp)

**Let any MCP client hand real coding work to [OpenCode](https://opencode.ai/).**

opencode-mcp is an MCP server that sits between your AI tool (Claude, Cursor, Windsurf, VS Code, and so on) and OpenCode's headless API. Your assistant asks for a feature, a bug fix, a refactor, or a test run, and an OpenCode session goes off and reads, writes, and executes code in your project, then reports back.

It ships 83 tools, 10 resources, and 6 prompts, works across multiple projects at once, and can start OpenCode for you if nothing is running locally.

> **This is a fork.** You are looking at [CwbhX/opencode-mcp](https://github.com/CwbhX/opencode-mcp), a fork of [AlaeddineMessadi/opencode-mcp](https://github.com/AlaeddineMessadi/opencode-mcp). Install it from GitHub. `npx opencode-mcp` and `npm i -g opencode-mcp` pull the npm package, which is upstream, not this one.

## Why this fork exists

OpenCode's server API changed, and the original project still speaks the old one. Against a current OpenCode install you get tasks that look finished when they are not, prompts that occasionally get sent twice, and no way to answer when OpenCode stops to ask you something.

This fork tracks OpenCode 1.18 and fixes those problems. In practice that means:

- Background work is tracked until it really finishes. An idle session is not the same as a done session.
- When OpenCode asks a question or needs permission, that question comes back to you. Nothing gets auto-approved just to make the wait succeed.
- The model you ask for is the model that runs. If it is missing or unavailable, you get an error rather than a silent swap.
- Thinking and effort settings belong to each model instead of a global fast/smart list. Ask OpenCode which variants a model has, then pass one as `variant`. Leave it off for the model's default. Init, summarize, and shell do not take a thinking setting.
- Project paths must be real directories, so work lands where you meant it to.
- If nothing is listening on this machine, the bridge can start OpenCode locally. It will not do that because a remote server rejected you, and background jobs do not outlive the MCP client.

The full endpoint inventory and known limitations are in [Compatibility](docs/compatibility.md).

## What you get

**Delegation.** Tell Claude "build me a REST API" and it hands the job to OpenCode, which creates files, installs packages, writes tests, and comes back with a summary.

**Parallel work.** Fire off a task and keep going. `opencode_fire` returns a handle, and `opencode_check` or `opencode_wait` watches it.

**Any client.** Claude Desktop, Claude Code, Cursor, Windsurf, VS Code Copilot, Cline, Continue, Zed, Amazon Q, and anything else that speaks MCP.

**Attach or auto-start.** Point it at an OpenCode server you already run, or let it start one on loopback when nothing is there.

## Quick start

You need [OpenCode](https://opencode.ai/) installed first. Any of these will do:

```bash
curl -fsSL https://opencode.ai/install | bash
npm i -g opencode-ai
brew install sst/tap/opencode
```

Then add the bridge to your client.

**Claude Code:**

```bash
claude mcp add opencode -- npx -y github:CwbhX/opencode-mcp
```

**Claude Desktop, Cursor, Windsurf, Cline, Continue** (in your MCP config):

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

That is enough for a first try. The bridge will start OpenCode on loopback if nothing is listening. For anything long-running, run `opencode serve` yourself and attach to it instead. See [Recommended deployment](#recommended-deployment) for that setup, and [Configuration](docs/configuration.md) for other clients (VS Code Copilot, Zed, Amazon Q) and every environment variable.

## How it works

```
MCP Client  <--stdio-->  opencode-mcp  <--HTTP-->  OpenCode Server
(Claude, Cursor, etc.)   (this package)            (SDK child on loopback,
                                                    or external opencode serve)
```

Your client calls tools over stdio. This server turns them into HTTP requests against the OpenCode headless API.

On startup the bridge probes the server's health. If the connection is refused and `OPENCODE_BASE_URL` points at loopback, it starts an OpenCode process through `@opencode-ai/sdk`. That child runs in a separate process, so jobs started with `opencode_fire` die when the MCP process exits. A 401 or 403 never triggers a spawn. If you want shared or long-lived work, run `opencode serve` yourself.

Every tool takes an optional `directory`. It has to be an absolute path to a directory that already exists. `~` and relative paths are rejected. When present, it is sent as the `x-opencode-directory` header. When absent, OpenCode falls back to its own project context, not the bridge's working directory.

## Tools

Start with the workflow tools. They cover the common cases in one call each.

### Workflow tools

| Tool | What it does |
|---|---|
| `opencode_setup` | Check server health, providers, and project status. Run this first. |
| `opencode_ask` | Create a session, send a prompt, return the answer. |
| `opencode_reply` | Send a follow-up in an existing session. |
| `opencode_run` | Submit a prompt and wait for the job to finish. |
| `opencode_fire` | Submit a prompt and return right away with a handle: `jobId`, `sessionId`, `requestMessageID`, `directory`. |
| `opencode_check` | Look at a handle. Prefer `jobId`. An idle or missing status is not success. |
| `opencode_wait` | Poll an async session until it finishes. |
| `opencode_conversation` | Formatted conversation history. |
| `opencode_sessions_overview` | Quick overview of all sessions. |
| `opencode_context` | Project, VCS, config, and agents in one call. |
| `opencode_review_changes` | Formatted diff summary for a session. |
| `opencode_provider_test` | Check whether a provider works. |
| `opencode_status` | Health, providers, sessions, and VCS in one dashboard. |

### Common patterns

Ask a quick question:

```
opencode_ask({ prompt: "Explain the auth flow in this project" })
```

Build something and wait for it:

```
opencode_run({ prompt: "Add input validation to POST /api/users", maxDurationSeconds: 300 })
```

Run tasks in the background:

```
opencode_fire({ prompt: "Refactor the auth module to use JWT", providerID: "...", modelID: "..." })
→ handle: jobId, sessionId, requestMessageID, directory

opencode_check({ jobId: "job_..." })
→ or pass sessionId + requestMessageID + directory
```

Pick a thinking or effort level. Variant names are per model, so list them first:

```
opencode_provider_models({ providerId: "opencode", limit: 0 })
opencode_ask({ prompt: "...", providerID: "opencode", modelID: "...", variant: "<listed-key>" })
```

Omit `variant` to get the model's default. There is no global thinking enum to guess at. More in [Thinking / effort variants](docs/tools.md#thinking--effort-variants).

### Everything else

| Category | Count | Description |
|---|---|---|
| [Workflow](docs/tools.md#workflow-tools) | 13 | The composite tools above |
| [Session](docs/tools.md#session-tools) | 20 | Create, list, fork, share, abort, revert, permissions |
| [Message](docs/tools.md#message-tools) | 6 | Send prompts, execute commands, run shell |
| [Question](docs/tools.md#question-tools) | 3 | List, reply to, or reject pending questions from OpenCode |
| [File & Search](docs/tools.md#file--search-tools) | 6 | Search text and regex, find files and symbols, read files |
| [System](docs/tools.md#system--monitoring-tools) | 13 | Health, VCS, LSP, MCP servers, agents, logging |
| [TUI Control](docs/tools.md#tui-control-tools) | 9 | Remote-control an attached OpenCode TUI (only when one is attached) |
| [Provider & Auth](docs/tools.md#provider--auth-tools) | 6 | List providers, models, and variants; set API keys; OAuth |
| [Config](docs/tools.md#config-tools) | 3 | Get and update configuration |
| [Project](docs/tools.md#project-tools) | 3 | List, inspect, and initialize projects |
| [Events](docs/tools.md#event-tools) | 1 | Poll real-time SSE events |

### Resources

Your client can read these directly, no tool call needed.

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

### Prompts

Guided workflows your client can offer as selectable actions.

| Prompt | Description |
|---|---|
| `opencode-code-review` | Review diffs from a session |
| `opencode-debug` | Step-by-step debugging |
| `opencode-project-setup` | Get oriented in a new project |
| `opencode-implement` | Have OpenCode build a feature |
| `opencode-best-practices` | Setup, tool selection, monitoring, and pitfalls |
| `opencode-session-summary` | Summarize what happened in a session |

## Working across projects

Pass `directory` to any tool to target a different project. No restart needed.

```
opencode_ask({ directory: "/home/user/mobile-app", prompt: "Add navigation" })
opencode_ask({ directory: "/home/user/web-app", prompt: "Add auth" })
```

For a brand new directory, or one OpenCode has not seen yet, call `opencode_project_init` first so the server registers it:

```
opencode_project_init({ path: "/home/user/new-project" })
// → "Successfully initialized project directory at: /home/user/new-project"

opencode_run({ directory: "/home/user/new-project", prompt: "Set up a Vite + React app" })
```

## Recommended deployment

The default auto-start is fine for trying things out. For real use, run OpenCode yourself and attach to it. Background jobs then survive your MCP client restarting, and several clients can share the same server.

Start the server:

```bash
opencode serve --port 4096 --hostname 127.0.0.1
```

Then tell the bridge to attach and never spawn:

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

The last three lines are optional. They pin a default model, refuse calls that do not name a full provider/model pair, and reject anything outside the allowlist.

A few things worth knowing:

- `jobId` handles live in the bridge's memory. If the bridge restarts, recover a job with `sessionId`, `requestMessageID`, and `directory` instead.
- Auto-start only ever kicks in for a genuine connection refusal on `127.0.0.1`, `localhost`, or `::1`.
- Do not set OpenCode's global `permission: allow` to make headless runs go through. Answer permission and question blocks explicitly with the question tools.

### Environment variables

All optional. You only need them if you changed something on the OpenCode side.

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_BASE_URL` | `http://127.0.0.1:4096` | OpenCode server URL |
| `OPENCODE_SERVER_USERNAME` | `opencode` | HTTP basic auth username |
| `OPENCODE_SERVER_PASSWORD` | *(none)* | HTTP basic auth password. Setting it turns auth on. |
| `OPENCODE_AUTO_SERVE` | `true` | Start an SDK child on loopback when the health probe is refused. 401, HTML, TLS, DNS, and generic `fetch failed` errors never spawn. |
| `OPENCODE_DEFAULT_PROVIDER` | *(none)* | Default provider ID. Set together with `OPENCODE_DEFAULT_MODEL`. |
| `OPENCODE_DEFAULT_MODEL` | *(none)* | Default model ID. Set together with `OPENCODE_DEFAULT_PROVIDER`. |
| `OPENCODE_REQUIRE_EXPLICIT_MODEL` | *(unset)* | When `true`, every call needs an explicit or configured provider/model pair. |
| `OPENCODE_ALLOWED_MODELS` | *(unset)* | JSON array of allowed `provider/model` strings. Omitting the pair does not bypass it, and the first entry is not used as a fallback. |

### What has been verified

Tested against OpenCode v1.18.29: an isolated tagged-server `session_create` through MCP, and one live `opencode_fire` then `opencode_wait` round trip with `opencode/muse-spark-1.3-contributor-free`. The requested model matched the one that ran, and the job reported `state=succeeded`.

That is a smoke test, not a guarantee for every tool, host OS, remote filesystem, or newer OpenCode version. Two known edges: path segments containing a literal `%` are rejected, and the bridge's model allowlist does not reach OpenCode subagents, title generation, or config changed outside this process.

## Development

```bash
git clone https://github.com/CwbhX/opencode-mcp.git
cd opencode-mcp
npm install
npm run build
npm start        # run the MCP server
npm run dev      # watch mode
```

Tests come in layers:

```bash
npm test             # unit + integration, minus the opt-in layers below
npm run test:unit
npm run test:wire    # HTTP-client fake + real MCP stdio against a fake OpenCode (builds first)
npm run test:server  # Layer C: skipped unless OPENCODE_MCP_SERVER_TEST=1
npm run test:live    # Layer D: skipped without opt-in; fails if opted in but misconfigured
```

Layer C runs against a real OpenCode binary. If you opt in without one, it fails rather than skipping:

```bash
OPENCODE_MCP_SERVER_BINARY=/absolute/path/to/opencode-1.18.29 \
OPENCODE_MCP_SERVER_TEST=1 \
npm run test:server
```

Layer D talks to a live model from a scratch directory, not this repo:

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

There is also a longer stdio smoke test you can run against any server that is already up:

```bash
npm run build && node scripts/mcp-smoke-test.mjs
```

## Documentation

- [Getting started](docs/getting-started.md), step-by-step setup
- [Configuration](docs/configuration.md), env vars and every client config
- [Tools reference](docs/tools.md), all registered tools in detail
- [Compatibility](docs/compatibility.md), endpoint inventory, test IDs, limitations
- [Resources](docs/resources.md), the 10 MCP resources
- [Prompts](docs/prompts.md), the 6 guided workflows
- [Examples](docs/examples.md), real workflow examples
- [Architecture](docs/architecture.md), system design and data flow

## References

- [OpenCode](https://opencode.ai/), [OpenCode docs](https://opencode.ai/docs/), [OpenCode server API](https://opencode.ai/docs/server/)
- [Model Context Protocol](https://modelcontextprotocol.io/)

## License

[MIT](LICENSE)
