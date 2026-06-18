import "server-only";
import { generateText, type ModelMessage } from "ai";
import { z } from "zod";

import { openrouter, TRIAGE_MODEL } from "@/server/lib/openrouter";

/** A tappable follow-up chip: short `label`, fuller `prompt` sent on tap. */
export type Suggestion = { label: string; prompt: string };

const SCHEMA = z
  .array(
    z.object({
      label: z.string().min(1).max(48),
      prompt: z.string().min(1).max(160),
    }),
  )
  .max(4);

const SYSTEM = `You propose up to 3 SHORT follow-up actions the user might want next in a Gmail + Google Calendar assistant, based on the conversation so far.

Output ONLY a JSON array of {"label","prompt"} objects — no prose, no code fences, no markdown.
- label: 2-5 words shown on a chip. prompt: the full instruction sent when the chip is tapped.
- Be CONCRETE: reference the actual people, subjects, or topics from the conversation when you can.
- READING / DRAFTING / SUMMARIZING / SEARCHING only. NEVER suggest sending, replying-and-sending, trashing, deleting, archiving, or inviting — nothing irreversible or outward-facing.
- Never repeat the user's last request. Never generic filler ("Tell me more", "Anything else?").
- If nothing genuinely useful comes to mind, output exactly [].`;

/** Tolerant parse: slice the first JSON array out of the text, validate, else []. */
function parse(text: string): Suggestion[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const raw: unknown = JSON.parse(text.slice(start, end + 1));
    const result = SCHEMA.safeParse(raw);
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

/**
 * Generate follow-up chips from the conversation. Runs AFTER the agent's answer
 * has already streamed, so its latency is invisible. A cheap, cache-pinned
 * DeepSeek call; returns [] on any error (the feature is purely additive).
 */
export async function suggestFollowups(
  messages: ModelMessage[],
): Promise<Suggestion[]> {
  try {
    const { text } = await generateText({
      model: openrouter(TRIAGE_MODEL),
      temperature: 0.4,
      maxOutputTokens: 220,
      system: SYSTEM,
      messages: messages.slice(-6),
    });
    return parse(text);
  } catch {
    return [];
  }
}
