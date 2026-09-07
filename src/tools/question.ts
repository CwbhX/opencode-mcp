import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../client.js";
import { directoryParam, readOnly, toolError, toolResult } from "../helpers.js";
import { validateDirectory } from "../request-context.js";

function asQuestionList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const data = (raw as { data?: unknown }).data;
    if (Array.isArray(data)) return data;
    const questions = (raw as { questions?: unknown }).questions;
    if (Array.isArray(questions)) return questions;
  }
  return [];
}

function optionLabel(opt: unknown): string {
  if (!opt || typeof opt !== "object") return String(opt);
  const o = opt as Record<string, unknown>;
  const label = typeof o.label === "string" ? o.label : "?";
  const description = typeof o.description === "string" ? ` — ${o.description}` : "";
  return `${label}${description}`;
}

function formatQuestionRequest(raw: unknown): string {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const id = typeof r.id === "string" ? r.id : "?";
  const session = String(r.sessionID ?? r.sessionId ?? "?");
  const questions = Array.isArray(r.questions) ? r.questions : [];
  const lines = [`- **${id}** (session: ${session})`];
  questions.forEach((q, i) => {
    const info = q && typeof q === "object" ? (q as Record<string, unknown>) : {};
    const header = typeof info.header === "string" ? info.header : "";
    const question = typeof info.question === "string" ? info.question : "";
    const title = [question, header && `[${header}]`].filter(Boolean).join(" ");
    lines.push(`  ${i + 1}. ${title || "Question"}`);
    const options = Array.isArray(info.options) ? info.options : [];
    if (options.length > 0) {
      lines.push(`     Options: ${options.map(optionLabel).join("; ")}`);
    }
  });
  return lines.join("\n");
}

function formatQuestions(raw: unknown): string {
  const requests = asQuestionList(raw);
  if (requests.length === 0) return "No pending questions.";
  return (
    `## Pending Questions (${requests.length})\n\n` +
    requests.map(formatQuestionRequest).join("\n\n") +
    `\n\nReply with: \`opencode_question_reply({ requestID: "REQUEST_ID", answers: [["label"]] })\``
  );
}

export function registerQuestionTools(
  server: McpServer,
  client: OpenCodeClient,
) {
  server.tool(
    "opencode_question_list",
    "List pending question requests from the OpenCode agent. Reply with opencode_question_reply or dismiss with opencode_question_reject.",
    {
      directory: directoryParam,
    },
    readOnly,
    async ({ directory }) => {
      try {
        const scoped = validateDirectory(directory);
        const raw = await client.get("/question", undefined, scoped);
        return toolResult(formatQuestions(raw));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_question_reply",
    "Reply to a pending question request. answers is an array of selected-label arrays, one inner array per question, in question order.",
    {
      requestID: z.string().describe("Question request ID"),
      answers: z
        .array(z.array(z.string()))
        .describe("Answers in question order; each inner array is selected labels"),
      directory: directoryParam,
    },
    async ({ requestID, answers, directory }) => {
      try {
        const scoped = validateDirectory(directory);
        await client.post(
          `/question/${requestID}/reply`,
          { answers },
          { directory: scoped },
        );
        return toolResult(`Question ${requestID} answered.`);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_question_reject",
    "Reject a pending question request without answering.",
    {
      requestID: z.string().describe("Question request ID"),
      directory: directoryParam,
    },
    async ({ requestID, directory }) => {
      try {
        const scoped = validateDirectory(directory);
        await client.post(
          `/question/${requestID}/reject`,
          undefined,
          { directory: scoped },
        );
        return toolResult(`Question ${requestID} rejected.`);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
