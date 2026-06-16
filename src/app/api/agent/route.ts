import { createOpenAI } from "@ai-sdk/openai";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import { type NextRequest, NextResponse } from "next/server";

import { env } from "@/env";
import { buildAgentTools } from "@/server/lib/agent-tools";
import { clientIp, rateLimit } from "@/server/lib/rate-limit";
import { getTenantId } from "@/server/lib/session";

export const maxDuration = 60;

// OpenRouter speaks the OpenAI protocol; DeepSeek does the thinking.
const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: env.OPENROUTER_API_KEY,
  headers: { "X-Title": "Helm" },
});

const MODEL = "deepseek/deepseek-v4-flash";

function systemPrompt() {
  const now = new Date();
  return `You are the Helm agent: a fast, precise assistant living inside the user's Gmail and Google Calendar command center. You act on their real account through tools.

Current date and time: ${now.toISOString()} (UTC). The user's local timezone is likely Asia/Kolkata (+05:30) — when they say "tomorrow 9am" they mean their local time; produce ISO datetimes with an explicit +05:30 offset unless they specify otherwise.

Rules:
- Use tools to look things up instead of guessing. Search before reading; read before summarising a specific email.
- Sending email or invites is allowed when the user asked for it in this conversation. If the instruction is ambiguous about sending, save a draft instead and say so.
- Default meeting length is 30 minutes when the user gives only a start time.
- Be concise. Plain sentences, no headings, no bullet spam. Confirm what you did with the key facts (who, what, when).
- Never invent message ids, addresses or events. If a tool returns nothing, say so plainly.
- You cannot delete events or send to multiple recipients in one email yet; say so if asked.`;
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
  // Keep the context light: the last 12 UI messages are plenty.
  const recent = messages.slice(-12);

  const result = streamText({
    model: openrouter(MODEL),
    system: systemPrompt(),
    messages: await convertToModelMessages(recent),
    tools: buildAgentTools(tenantId),
    stopWhen: stepCountIs(8),
    onError: ({ error }) => {
      console.error("agent stream error:", error instanceof Error ? error.message : error);
    },
  });

  return result.toUIMessageStreamResponse();
}
