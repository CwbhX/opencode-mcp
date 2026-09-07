#!/usr/bin/env node

/**
 * Layer D opt-in live smoke. Not part of `npm test`.
 *
 * Requires:
 *   OPENCODE_MCP_LIVE_TEST=1
 *   OPENCODE_BASE_URL
 *   OPENCODE_DEFAULT_PROVIDER
 *   OPENCODE_DEFAULT_MODEL
 *
 * Uses a scratch directory (not this repo). Prints sanitized JSON only.
 * Never logs passwords, Authorization headers, or API keys.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET_KEY = /password|authorization|api[_-]?key|secret|token|credential/i;

function skip(message) {
  console.log(message);
  process.exit(0);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

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

function basicAuthHeader() {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) return undefined;
  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function headers(directory) {
  const out = { Accept: "application/json" };
  const auth = basicAuthHeader();
  if (auth) out.Authorization = auth;
  if (directory) out["x-opencode-directory"] = directory;
  return out;
}

async function request(baseUrl, method, path, { directory, body } = {}) {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const reqHeaders = headers(directory);
  let bodyInit;
  if (body !== undefined) {
    reqHeaders["Content-Type"] = "application/json";
    bodyInit = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers: reqHeaders, body: bodyInit });
  const text = await res.text();
  if (res.status === 204) {
    return { status: 204, json: null };
  }
  let json = null;
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { nonJson: text.slice(0, 200) };
    }
  }
  if (!res.ok) {
    throw new Error(`OpenCode ${method} ${path} failed (${res.status})`);
  }
  return { status: res.status, json };
}

if (process.env.OPENCODE_MCP_LIVE_TEST !== "1") {
  skip(
    "skipped: set OPENCODE_MCP_LIVE_TEST=1 and a full OPENCODE_BASE_URL + OPENCODE_DEFAULT_PROVIDER + OPENCODE_DEFAULT_MODEL pair to run the live smoke test.",
  );
}

const baseUrl = process.env.OPENCODE_BASE_URL;
const providerID = process.env.OPENCODE_DEFAULT_PROVIDER;
const modelID = process.env.OPENCODE_DEFAULT_MODEL;

if (!baseUrl || !providerID || !modelID) {
  skip(
    "skipped: OPENCODE_MCP_LIVE_TEST=1 is set, but OPENCODE_BASE_URL, OPENCODE_DEFAULT_PROVIDER, and OPENCODE_DEFAULT_MODEL are all required. No fallback model is chosen.",
  );
}

const scratch = await mkdtemp(join(tmpdir(), "opencode-mcp-live-"));

try {
  const created = await request(baseUrl, "POST", "/session", {
    directory: scratch,
    body: { title: "opencode-mcp live smoke" },
  });
  const sessionId = created.json?.id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    fail("live smoke: session create did not return an id");
  }

  const prompted = await request(baseUrl, "POST", `/session/${sessionId}/message`, {
    directory: scratch,
    body: {
      parts: [{ type: "text", text: "Reply with the single word pong and nothing else." }],
      model: { providerID, modelID },
    },
  });

  const info = prompted.json?.info;
  const observedProvider =
    info?.model?.providerID ?? info?.providerID ?? null;
  const observedModel = info?.model?.modelID ?? info?.modelID ?? null;

  console.log(
    JSON.stringify(
      redact({
        ok: true,
        directory: scratch,
        sessionId,
        requested: { providerID, modelID },
        observed: { providerID: observedProvider, modelID: observedModel },
        status: prompted.status,
      }),
      null,
      2,
    ),
  );
} catch (err) {
  fail(`live smoke failed: ${err instanceof Error ? err.message : "unknown error"}`);
} finally {
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
