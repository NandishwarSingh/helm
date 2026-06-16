import "server-only";
import { generateText } from "ai";
import { z } from "zod";

import { openrouter, TRIAGE_MODEL } from "@/server/lib/openrouter";

export type TriageCandidate = {
  id: string;
  from: string;
  subject: string;
  snippet: string;
};

export type TriageVerdict = {
  messageId: string;
  priority: "urgent" | "reply" | "fyi" | "low";
  reason: string;
};

const BATCH_SIZE = 20;

// The model answers with positional indexes, never message ids — long ids
// get mangled by small models, indexes do not.
const verdictSchema = z.array(
  z.object({
    i: z.number().int().min(0),
    p: z.enum(["urgent", "reply", "fyi", "low"]),
    r: z.string().max(120).default(""),
  }),
);

const SYSTEM = `You are an email triage engine. Decide how urgently the mailbox owner must act on each email.
Categories:
- urgent: time-critical or high-stakes. Deadlines, security alerts, interviews, payments due, anything from a boss or client that is blocking.
- reply: a real person is waiting for the owner's answer or action, but it is not time-critical.
- fyi: worth seeing. Receipts, confirmations, status updates, genuine personal mail needing no action.
- low: bulk. Promotions, newsletters, social notifications, automated digests.
Respond with ONLY a JSON array, one object per input email, no prose and no markdown fences:
[{"i": <index from input>, "p": "urgent"|"reply"|"fyi"|"low", "r": "<reason, max 8 words>"}]`;

function parseVerdicts(text: string): z.infer<typeof verdictSchema> {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    const result = verdictSchema.safeParse(parsed);
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

async function classifyBatch(
  batch: TriageCandidate[],
): Promise<TriageVerdict[]> {
  const payload = batch.map((item, i) => ({
    i,
    from: item.from.slice(0, 120),
    subject: item.subject.slice(0, 160),
    snippet: item.snippet.slice(0, 200),
  }));
  const { text } = await generateText({
    model: openrouter(TRIAGE_MODEL),
    temperature: 0,
    system: SYSTEM,
    prompt: JSON.stringify(payload),
  });
  const verdicts: TriageVerdict[] = [];
  for (const verdict of parseVerdicts(text)) {
    const candidate = batch[verdict.i];
    if (!candidate) continue;
    verdicts.push({
      messageId: candidate.id,
      priority: verdict.p,
      reason: verdict.r.trim(),
    });
  }
  return verdicts;
}

/** Classify a bounded set of messages; batches run in parallel. */
export async function classifyEmails(
  candidates: TriageCandidate[],
): Promise<TriageVerdict[]> {
  const batches: TriageCandidate[][] = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    batches.push(candidates.slice(i, i + BATCH_SIZE));
  }
  const results = await Promise.all(batches.map(classifyBatch));
  return results.flat();
}
