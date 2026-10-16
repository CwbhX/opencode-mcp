/**
 * Layer C: tagged OpenCode process.
 *
 * Opt-in: OPENCODE_MCP_SERVER_TEST=1
 * Required when opted in: OPENCODE_MCP_SERVER_BINARY=/absolute/path/to/opencode
 *
 * The comparison target is OpenCode v2 (any 2.x binary; set
 * OPENCODE_MCP_SERVER_TARGET_VERSION to pin an exact version). A v1
 * binary is not accepted. Missing opt-in is a skip, not a pass.
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
const TARGET_VERSION = process.env.OPENCODE_MCP_SERVER_TARGET_VERSION;
const SERVER_PASSWORD = "layer-c-test-password";
const enabled = process.env.OPENCODE_MCP_SERVER_TEST === "1";
const binary = process.env.OPENCODE_MCP_SERVER_BINARY;

function versionOf(exe: string): string {
  const result = spawnSync(exe, ["--version"], { encoding: "utf8" });
  const out = result.stdout || result.stderr || "";
  return out.match(/\d+\.\d+\.\d+/)?.[0] ?? "";
}

function versionAccepted(reported: string): boolean {
  return TARGET_VERSION ? reported === TARGET_VERSION : reported.startsWith("2.");
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<{ version?: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no probe yet";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/info`, {
        headers: {
          Authorization:
            "Basic " + Buffer.from(`opencode:${SERVER_PASSWORD}`).toString("base64"),
        },
      });
      if (res.ok) {
        const body = (await res.json()) as { version?: string; urls?: unknown };
        if (typeof body.version === "string" && Array.isArray(body.urls)) return body;
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

  it("FUP-055: uses OPENCODE_MCP_SERVER_BINARY at an OpenCode v2 version", async () => {
    if (!binary) {
      throw new Error(
        "OPENCODE_MCP_SERVER_TEST=1 requires OPENCODE_MCP_SERVER_BINARY to be an absolute path to an opencode v2 binary.",
      );
    }
    if (!path.isAbsolute(binary)) {
      throw new Error("OPENCODE_MCP_SERVER_BINARY must be an absolute path.");
    }
    if (!existsSync(binary)) {
      throw new Error(`OPENCODE_MCP_SERVER_BINARY does not exist: ${binary}`);
    }
    const reported = versionOf(binary);
    expect(
      versionAccepted(reported),
      `expected ${TARGET_VERSION ?? "a 2.x version"}, got ${reported || "(unparsed)"}`,
    ).toBe(true);
  });

  it("FUP-058 partial: isolated serve + MCP session_create against the tagged binary", async () => {
    if (!binary || !existsSync(binary) || !versionAccepted(versionOf(binary))) {
      throw new Error(
        "Tagged-server MCP smoke requires OPENCODE_MCP_SERVER_BINARY pointing at an opencode v2 binary.",
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
        { $schema: "https://opencode.ai/config.json" },
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
        XDG_CACHE_HOME: path.join(scratch, "cache"),
        XDG_STATE_HOME: path.join(scratch, "state"),
        OPENCODE_SERVER_PASSWORD: SERVER_PASSWORD,
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
    expect(versionAccepted(health.version ?? "")).toBe(true);

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST],
      cwd: ROOT,
      env: Object.fromEntries(
        Object.entries({
          ...process.env,
          OPENCODE_BASE_URL: baseUrl,
          OPENCODE_AUTO_SERVE: "false",
          OPENCODE_SERVER_PASSWORD: SERVER_PASSWORD,
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
