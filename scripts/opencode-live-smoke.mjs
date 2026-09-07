#!/usr/bin/env node

/**
 * Layer D opt-in live MCP smoke. Not part of default `npm test`.
 *
 * Requires:
 *   OPENCODE_MCP_LIVE_TEST=1
 *   OPENCODE_BASE_URL          separately managed OpenCode
 *   OPENCODE_DEFAULT_PROVIDER
 *   OPENCODE_DEFAULT_MODEL
 *
 * Optional: OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD
 *
 * Uses a scratch directory (not this repo). Prints sanitized JSON only.
 * Never logs passwords, Authorization headers, or API keys.
 * Explicit opt-in with missing configuration is a failure, not a skip.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  evaluateLiveTaskResult,
  parseTaskJsonBlock,
} from "./live-result-validator.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPT_DIR);
const DIST = join(ROOT, "dist", "index.js");
const SECRET_KEY = /password|authorization|api[_-]?key|secret|token|credential/i;

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? "[redacted]" : redact(nested);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 4000) {
    return `${value.slice(0, 4000)}…`;
  }
  return value;
}

function textOf(result) {
  return (result?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function spawnEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  Object.assign(env, extra);
  return env;
}

const live = process.env.OPENCODE_MCP_LIVE_TEST === "1";
if (!live) {
  console.log(
    JSON.stringify({
      ok: false,
      skipped: true,
      reason:
        "Set OPENCODE_MCP_LIVE_TEST=1 with OPENCODE_BASE_URL, OPENCODE_DEFAULT_PROVIDER, and OPENCODE_DEFAULT_MODEL to run the live MCP smoke.",
    }),
  );
  process.exit(0);
}

const baseUrl = process.env.OPENCODE_BASE_URL;
const providerID = process.env.OPENCODE_DEFAULT_PROVIDER;
const modelID = process.env.OPENCODE_DEFAULT_MODEL;

if (!baseUrl || !providerID || !modelID) {
  console.error(
    JSON.stringify({
      ok: false,
      skipped: false,
      reason:
        "OPENCODE_MCP_LIVE_TEST=1 requires OPENCODE_BASE_URL, OPENCODE_DEFAULT_PROVIDER, and OPENCODE_DEFAULT_MODEL. No fallback model is chosen.",
    }),
  );
  process.exit(1);
}

if (!existsSync(DIST)) {
  console.error(
    JSON.stringify({
      ok: false,
      skipped: false,
      reason: `Built bridge missing at ${DIST}. Run npm run build first.`,
    }),
  );
  process.exit(1);
}

const nonce = `live-nonce-${Date.now().toString(36)}`;
let scratch;
let keepScratch = false;
let client;
let transport;
let exitCode = 1;

try {
  scratch = await mkdtemp(join(tmpdir(), "opencode-mcp-live-"));
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST],
    cwd: ROOT,
    env: spawnEnv({
      OPENCODE_BASE_URL: baseUrl,
      OPENCODE_AUTO_SERVE: "false",
      OPENCODE_DEFAULT_PROVIDER: providerID,
      OPENCODE_DEFAULT_MODEL: modelID,
      OPENCODE_REQUIRE_EXPLICIT_MODEL: "true",
      OPENCODE_ALLOWED_MODELS: JSON.stringify([`${providerID}/${modelID}`]),
    }),
    stderr: "pipe",
  });
  client = new Client({ name: "opencode-mcp-live-smoke", version: "0.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  const fired = await client.callTool({
    name: "opencode_fire",
    arguments: {
      prompt: `Reply with exactly this nonce and nothing else: ${nonce}`,
      directory: scratch,
      providerID,
      modelID,
      title: `[probe] ${providerID}/${modelID}`,
    },
  });
  const fireText = textOf(fired);
  const fireJson = parseTaskJsonBlock(fireText);
  if (!fireJson?.jobId) {
    keepScratch = true;
    throw new Error("fire did not return a recovery handle");
  }

  const waited = await client.callTool({
    name: "opencode_wait",
    arguments: {
      jobId: fireJson.jobId,
      timeoutSeconds: 180,
      pollIntervalMs: 500,
    },
  });
  const waitText = textOf(waited);
  const waitJson = parseTaskJsonBlock(waitText);
  const evaluated = evaluateLiveTaskResult({
    requestedProvider: providerID,
    requestedModel: modelID,
    nonce,
    mcpInitialized: true,
    toolsListed: names.has("opencode_fire") && names.has("opencode_wait"),
    promptAsyncCount: 1,
    result: waitJson,
    isError: waited.isError === true,
    text: waitText,
  });

  if (!evaluated.ok) {
    keepScratch =
      waitJson?.mayStillBeRunning === true ||
      waitJson?.submissionState === "accepted" ||
      waitJson?.submissionState === "unknown";
    console.error(
      JSON.stringify(
        redact({
          ok: false,
          skipped: false,
          failures: evaluated.failures,
          jobId: waitJson?.jobId ?? fireJson.jobId,
          sessionId: waitJson?.sessionId ?? fireJson.sessionId,
          keepScratch,
          scratch: keepScratch ? scratch : undefined,
        }),
      ),
    );
    exitCode = 1;
  } else {
    console.log(
      JSON.stringify(
        redact({
          ok: true,
          skipped: false,
          jobId: waitJson.jobId,
          sessionId: waitJson.sessionId,
          requestMessageID: waitJson.requestMessageID,
          requestedModel: waitJson.requestedModel,
          observedModel: waitJson.observedModel,
          state: waitJson.state,
        }),
      ),
    );
    exitCode = 0;
  }
} catch (error) {
  keepScratch = true;
  console.error(
    JSON.stringify(
      redact({
        ok: false,
        skipped: false,
        reason: error instanceof Error ? error.message : String(error),
        scratch,
        keepScratch,
      }),
    ),
  );
  exitCode = 1;
} finally {
  await client?.close?.().catch(() => undefined);
  await transport?.close?.().catch(() => undefined);
  if (scratch && !keepScratch) {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  } else if (scratch && keepScratch) {
    console.error(
      JSON.stringify({
        cleanup: "retained",
        scratch,
        action: "Inspect the session, then delete this scratch directory manually if unused.",
      }),
    );
  }
}

process.exit(exitCode);
