import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import { type NextRequest, NextResponse } from "next/server";

import { buildAgentTools } from "@/server/lib/agent-tools";
import { AGENT_MODEL, openrouter } from "@/server/lib/openrouter";
import { clientIp, rateLimit } from "@/server/lib/rate-limit";
import { getTenantId } from "@/server/lib/session";

export const maxDuration = 60;

function systemPrompt() {
  const now = new Date();
  return `You are the Helm agent: a fast, precise assistant living inside the user's Gmail and Google Calendar command center. You act on their real account through tools.

Current date and time: ${now.toISOString()} (UTC). The user's local timezone is likely Asia/Kolkata (+05:30) — when they say "tomorrow 9am" they mean their local time; produce ISO datetimes with an explicit +05:30 offset unless they specify otherwise.

Rules:
- Use tools to look things up instead of guessing. Search before reading; read before summarising a specific email.
- Do NOT narrate between tool calls. Call tools silently; your prose belongs in one final answer after all tool work is done.
- Tool budget: about 12 calls per request. Plan the whole task first, then execute each step exactly once. NEVER call the same tool with the same arguments twice — the result is already in this conversation.
- Search with one or two short keywords (e.g. "security"), never full phrases. If a search returns 0, try ONE shorter keyword; if still 0, move on and report it.
- If a step fails twice, stop retrying it and note the failure in your final answer.
- When the user refers to something from earlier in this conversation (an email you read, a meeting you booked), take the details from the conversation — do not re-query for them.
- Sending email or invites is allowed when the user asked for it in this conversation. If the instruction is ambiguous about sending, save a draft instead and say so.
- Default meeting length is 30 minutes when the user gives only a start time.
- Be concise. Short paragraphs; hyphen or numbered lists and **bold** are fine; never headings, tables, code blocks, nested lists, horizontal rules or emojis of any kind.
- Never invent message ids, addresses or events. If a tool returns nothing, say so plainly.
- ALWAYS end with a final text answer summarising what you did, including anything you could not do and why — even if steps failed.
- Your recap must be literally true: only claim an action if you actually made that tool call in this conversation. Never invent attempts, failures, or tool names.
- If the user references something from a previous session that is not in this conversation (like "the meeting you just booked"), check for it at most once; if absent, say so and continue with the rest of the task.`;
}

export async function POST(request: NextRequest) {
  const tenantId = await getTenantId();
  if (!tenantId) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }
  const { ok, retryAfterMs } = rateLimit(
    `agent:${clientIp(request.headers)}`,
    15,
    60_000,
  );
  if (!ok) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${Math.ceil(retryAfterMs / 1000)}s.` },
      { status: 429 },
    );
  }

  const { messages } = (await request.json()) as { messages: UIMessage[] };
  // Keep context bounded but roomy enough for multi-step follow-ups.
  const recent = messages.slice(-24);

  const result = streamText({
    model: openrouter(AGENT_MODEL),
    temperature: 0.2,
    system: systemPrompt(),
    messages: await convertToModelMessages(recent),
    tools: buildAgentTools(tenantId),
    stopWhen: stepCountIs(16),
    // Near the budget, withdraw the tools so the model must write its
    // final answer instead of dying mid-loop.
    prepareStep: ({ stepNumber }) =>
      stepNumber >= 12 ? { activeTools: [] } : undefined,
    onError: ({ error }) => {
      console.error("agent stream error:", error instanceof Error ? error.message : error);
    },
  });

  return result.toUIMessageStreamResponse();
}
