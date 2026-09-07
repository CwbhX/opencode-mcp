/**
 * Layer C: tagged OpenCode process.
 *
 * Opt-in: OPENCODE_MCP_SERVER_TEST=1
 * Required when opted in: OPENCODE_MCP_SERVER_BINARY=/absolute/path/to/opencode
 *
 * The comparison target is OpenCode v1.18.29. A PATH binary that is a
 * different version is not accepted. Missing opt-in is a skip, not a pass.
 * Opt-in with a missing or wrong binary fails.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIST = path.join(ROOT, "dist", "index.js");
const TARGET_VERSION = "1.18.29";
const enabled = process.env.OPENCODE_MCP_SERVER_TEST === "1";
const binary = process.env.OPENCODE_MCP_SERVER_BINARY;

function versionOf(exe: string): string {
  const result = spawnSync(exe, ["--version"], { encoding: "utf8" });
  return (result.stdout || result.stderr || "").trim().split(/\s+/)[0] ?? "";
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<{ version?: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no probe yet";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/global/health`);
      if (res.ok) {
        const body = (await res.json()) as { healthy?: boolean; version?: string };
        if (body.healthy === true) return body;
        lastError = `unhealthy: ${JSON.stringify(body)}`;
      } else {
        lastError = `HTTP ${res.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`OpenCode health probe failed: ${lastError}`);
}

describe.skipIf(!enabled)("Layer C tagged OpenCode (opt-in)", () => {
  let scratch: string | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let transport: StdioClientTransport | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
    client = undefined;
    transport = undefined;
    if (child && !child.killed) {
      child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (!child.killed) child.kill("SIGKILL");
    }
    child = undefined;
    if (scratch) {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      scratch = undefined;
    }
  });

  it("FUP-055: uses OPENCODE_MCP_SERVER_BINARY at exactly v1.18.29", async () => {
    if (!binary) {
      throw new Error(
        "OPENCODE_MCP_SERVER_TEST=1 requires OPENCODE_MCP_SERVER_BINARY to be an absolute path to opencode v1.18.29.",
      );
    }
    if (!path.isAbsolute(binary)) {
      throw new Error("OPENCODE_MCP_SERVER_BINARY must be an absolute path.");
    }
    if (!existsSync(binary)) {
      throw new Error(`OPENCODE_MCP_SERVER_BINARY does not exist: ${binary}`);
    }
    const reported = versionOf(binary);
    expect(reported).toBe(TARGET_VERSION);
  });

  it("FUP-058 partial: isolated serve + MCP session_create against the tagged binary", async () => {
    if (!binary || !existsSync(binary) || versionOf(binary) !== TARGET_VERSION) {
      throw new Error(
        "Tagged-server MCP smoke requires OPENCODE_MCP_SERVER_BINARY pointing at opencode v1.18.29.",
      );
    }
    if (!existsSync(DIST)) {
      throw new Error("dist/index.js is missing; run npm run build before test:server.");
    }

    scratch = await mkdtemp(path.join(tmpdir(), "opencode-mcp-c-"));
    const dataDir = path.join(scratch, "data");
    const configDir = path.join(scratch, "config");
    const projectDir = path.join(scratch, "project");
    await mkdir(dataDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(configDir, "opencode.json"),
      `${JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          model: "opencode/muse-spark-1.3-contributor-free",
        },
        null,
        2,
      )}\n`,
    );

    const port = 40000 + Math.floor(Math.random() * 1000);
    const baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(binary, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
      cwd: projectDir,
      env: {
        ...process.env,
        XDG_DATA_HOME: dataDir,
        XDG_CONFIG_HOME: configDir,
        OPENCODE_CONFIG_DIR: configDir,
        HOME: scratch,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: string[] = [];
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    child.on("exit", (code) => {
      if (code && code !== 0) {
        stderr.push(`opencode serve exited ${code}`);
      }
    });

    const health = await waitForHealth(baseUrl, 15_000).catch((error) => {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${stderr.join("")}`,
      );
    });
    expect(health.version).toBe(TARGET_VERSION);

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST],
      cwd: ROOT,
      env: Object.fromEntries(
        Object.entries({
          ...process.env,
          OPENCODE_BASE_URL: baseUrl,
          OPENCODE_AUTO_SERVE: "false",
        }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
      stderr: "pipe",
    });
    client = new Client({ name: "opencode-mcp-layer-c", version: "0.0.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "opencode_fire")).toBe(true);
    const created = await client.callTool({
      name: "opencode_session_create",
      arguments: { title: "layer-c-isolated", directory: projectDir },
    });
    expect(created.isError).not.toBe(true);
    // FUP-056 (localhost provider fixture, delayed async completion, two-step
    // tool turn) is not implemented here. Do not treat this smoke as that gate.
  });
});
