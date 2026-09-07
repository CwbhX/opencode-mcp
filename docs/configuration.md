# Configuration

## Environment Variables

Most variables are optional. You only need them if you changed the OpenCode
server URL/auth, or you want a default / allowlisted model pair.

| Variable | Description | Default | Required |
|---|---|---|---|
| `OPENCODE_BASE_URL` | URL of the OpenCode headless server | `http://127.0.0.1:4096` | No |
| `OPENCODE_SERVER_USERNAME` | HTTP basic auth username | `opencode` | No |
| `OPENCODE_SERVER_PASSWORD` | HTTP basic auth password | *(none — auth disabled)* | No |
| `OPENCODE_AUTO_SERVE` | Auto-start an SDK child on **loopback** only when the health probe is connection-refused. Generic `fetch failed` / 401 do not spawn. | `true` | No |
| `OPENCODE_DEFAULT_PROVIDER` | Default provider ID when not specified per-tool | *(none)* | No (must pair with model) |
| `OPENCODE_DEFAULT_MODEL` | Default model ID when not specified per-tool | *(none)* | No (must pair with provider) |
| `OPENCODE_REQUIRE_EXPLICIT_MODEL` | When `true`, require an explicit or configured full provider/model pair | *(unset)* | No |
| `OPENCODE_ALLOWED_MODELS` | JSON array of allowed `provider/model` strings | *(unset)* | No |
| `OPENCODE_MCP_LIVE_TEST` | Set to `1` to run `npm run test:live`. Opt-in with missing URL/model config fails. | *(unset)* | Test only |
| `OPENCODE_MCP_SERVER_TEST` | Set to `1` to enable Layer C tagged-server tests | *(unset)* | Test only |
| `OPENCODE_MCP_SERVER_BINARY` | Absolute path to the OpenCode executable for Layer C (must report `1.18.29`) | *(unset)* | Test only |

### Notes

- **Authentication is disabled by default.** It only activates when `OPENCODE_SERVER_PASSWORD` is set on both the OpenCode server and the MCP server.
- **Username and password are both optional.** The default username is `opencode`, matching the OpenCode server's default. You only need to set these if you've explicitly enabled auth on the server.
- **The base URL** should point to where `opencode serve` is listening. If running on the same machine with default settings, you don't need to set this.
- **Default provider/model** are optional. When set, tools that accept `providerID`/`modelID` use this pair when the call omits both. A single identifier (caller or default) is **rejected** and is not merged with the other side. There is no paid-model fallback and no hardcoded free-model list. Discover current models and thinking/effort variant keys with `opencode_setup` / `opencode_provider_list` / `opencode_provider_models`. `variant` is a per-call tool argument, not an environment variable.
- **`OPENCODE_REQUIRE_EXPLICIT_MODEL=true`** fails the call unless a full pair is supplied on the tool or via the two default env vars.
- **`OPENCODE_ALLOWED_MODELS`** must be a JSON array of strings such as `["opencode/muse-spark-1.3-contributor-free"]`. Other pairs are rejected before dispatch. A nonempty list cannot be bypassed by omitting the pair, and the first entry is not substituted for a different request. The list is a bridge policy; it does not lock OpenCode subagents, title generation, or config changed outside this process.
- **Auto-start** treats only typed connection-refused on loopback as permission to spawn. Generic `fetch failed`, DNS, TLS, HTML, timeout, and HTTP 401/403 do not start another server.
- **Directory validation** — `directory` must be an **absolute existing directory**. `~`, relative paths, files, control characters, and literal `%` path segments are rejected. Omitted `directory` uses the OpenCode server's project context, not this MCP process's cwd.

## MCP Client Configurations

Use `github:CwbhX/opencode-mcp` in every `npx` / `npm` command. The bare name `opencode-mcp` is the npm registry package (upstream), not this fork.

Below are complete configuration examples for every supported MCP client. All examples assume the OpenCode server is running on the default `http://127.0.0.1:4096` with no auth.

### Claude Desktop

**Config file location:**
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

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

### Claude Code (CLI)

```bash
# Add globally
claude mcp add opencode -- npx -y github:CwbhX/opencode-mcp

# Add with custom env
claude mcp add opencode --env OPENCODE_BASE_URL=http://192.168.1.10:4096 -- npx -y github:CwbhX/opencode-mcp

# Remove
claude mcp remove opencode
```

### Cursor

**Config file:** `.cursor/mcp.json` in your project root

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

### Windsurf

**Config file:** `~/.windsurf/mcp.json`

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

### VS Code — GitHub Copilot

**Config file:** `.vscode/settings.json` or user `settings.json`

```json
{
  "github.copilot.chat.mcp.servers": [
    {
      "name": "opencode",
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:CwbhX/opencode-mcp"]
    }
  ]
}
```

### Cline (VS Code extension)

Cline manages MCP servers through its own settings UI. Add a new server with:

- **Command:** `npx`
- **Args:** `-y github:CwbhX/opencode-mcp`
- **Transport:** stdio

### Continue

**Config file:** `.continue/config.json` in your project root or `~/.continue/config.json` globally

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

### Zed

**Config file:** `~/.config/zed/settings.json` or project `settings.json`

```json
{
  "context_servers": {
    "opencode": {
      "command": {
        "path": "npx",
        "args": ["-y", "github:CwbhX/opencode-mcp"]
      }
    }
  }
}
```

### Amazon Q

**Config file:** VS Code `settings.json`

```json
{
  "amazon-q.mcp.servers": [
    {
      "name": "opencode",
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:CwbhX/opencode-mcp"]
    }
  ]
}
```

### With authentication (optional)

Add `env` to any config above. This is only needed if you've enabled auth on the OpenCode server:

```json
{
  "mcpServers": {
    "opencode": {
      "command": "npx",
      "args": ["-y", "github:CwbhX/opencode-mcp"],
      "env": {
        "OPENCODE_BASE_URL": "http://127.0.0.1:4096",
        "OPENCODE_SERVER_USERNAME": "myuser",
        "OPENCODE_SERVER_PASSWORD": "mypass"
      }
    }
  }
}
```

### With global install (instead of npx)

If you prefer a global install for faster startup:

```bash
npm install -g github:CwbhX/opencode-mcp
```

Then use `opencode-mcp` directly in your config:

```json
{
  "mcpServers": {
    "opencode": {
      "command": "opencode-mcp"
    }
  }
}
```

## Permissions and questions

In headless mode, OpenCode may pause a session for a **permission** (file
write, shell, etc.) or a **user question**. That is a blocked result, not
success. Do **not** set global `permission: "allow"` as the default
workaround.

Prefer scoped rules in OpenCode config, then reply explicitly:

| Tool | Description |
|---|---|
| `opencode_permission_list` | List pending permission requests |
| `opencode_session_permission` | Reply `once`, `always`, or `reject` |
| `opencode_question_list` | List pending user questions |
| `opencode_question_reply` | Answer with selected-label arrays in question order |
| `opencode_question_reject` | Dismiss a question without answering |

`opencode_run` / `opencode_wait` return a blocked handle with the request
id. Never auto-approve, choose `"always"`, or invent answers just to finish
a wait.

## Auto-Start

Prefer a separately managed `opencode serve` with `OPENCODE_AUTO_SERVE=false`.
When auto-start is left on, the bridge probes
`OPENCODE_BASE_URL/global/health`:

- **Healthy** — attach; do not spawn.
- **Connection refused on loopback** (`127.0.0.1`, `localhost`, `::1`) — start
  an OpenCode **SDK child process**. This is not an in-process engine.
  `opencode_fire` work does not survive this MCP process exiting.
- **401/403, HTML, timeout, TLS/DNS, generic `fetch failed`, or a remote host**
  — fail with a classified error. **401 does not spawn** another server.

Disable auto-start if you manage OpenCode yourself (recommended):

```json
{
  "env": {
    "OPENCODE_AUTO_SERVE": "false",
    "OPENCODE_BASE_URL": "http://127.0.0.1:4096"
  }
}
```

## Manual OpenCode Server Setup

If you prefer to manage the server yourself:

```bash
# Default (no auth, port 4096)
opencode serve

# Custom port
opencode serve --port 8080

# With authentication (optional)
OPENCODE_SERVER_USERNAME=myuser OPENCODE_SERVER_PASSWORD=mypass opencode serve
```

The server exposes an OpenAPI 3.1 spec at `http://<host>:<port>/doc`.
