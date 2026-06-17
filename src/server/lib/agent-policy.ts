/**
 * Pure security policy for the agent's `run_script` tool — the three decisions
 * that gate every write to the user's real account:
 *
 *   1. isAllowedPath  — is this Corsair operation on the allowlist at all?
 *   2. isDestructive  — does it send/change/delete something outward-facing?
 *   3. isAffirmation  — did the user actually confirm a proposed destructive op?
 *
 * These live in their own dependency-free module (no `server-only`, no Corsair,
 * no isolated-vm) so they can be unit-tested directly — the sandbox's V8 isolate
 * and the live Gmail client are impossible to exercise in CI, but this logic is
 * exactly what decides allow-vs-deny, so it must be covered.
 */

/** Only `gmail`/`googlecalendar` `.api`/`.db` operations may run from a script. */
export const ALLOWED_PATH = /^(gmail|googlecalendar)\.(api|db)\.[a-zA-Z0-9_.]+$/;

export function isAllowedPath(path: string): boolean {
  return ALLOWED_PATH.test(path);
}

/**
 * Outward-facing or irreversible operations the agent must never perform without
 * the user's explicit confirmation: sending mail, sending a draft, trashing or
 * deleting mail, and any calendar write (which can fire real invites).
 * Reads and saving a draft are intentionally absent — they're always allowed.
 */
export const DESTRUCTIVE = [
  /^gmail\.api\.messages\.(send|trash|delete|batchDelete)$/,
  /^gmail\.api\.drafts\.send$/,
  /^googlecalendar\.api\.events\.(insert|create|update|patch|delete|move)$/,
];

export function isDestructive(path: string): boolean {
  return DESTRUCTIVE.some((re) => re.test(path));
}

/**
 * How many destructive operations a single confirmed message may trigger. One:
 * a user's "confirm" authorizes the ONE action the agent just proposed, never a
 * batch. This caps the blast radius of a prompt-injected script that slips a
 * "yes" through — it can't loop trash/delete across the whole mailbox.
 */
export const DESTRUCTIVE_BUDGET = 1;

// Single-word affirmations. A reply that is (after normalization) exactly one of
// these — or a short utterance beginning with one — counts as confirmation.
const AFFIRM_WORDS = [
  "confirm",
  "confirmed",
  "yes",
  "yep",
  "yeah",
  "ya",
  "sure",
  "ok",
  "okay",
  "proceed",
  "approve",
  "approved",
];

// Common multi-word confirmations, matched as whole normalized phrases.
const AFFIRM_PHRASES = new Set<string>([
  ...AFFIRM_WORDS,
  "go",
  "go ahead",
  "go for it",
  "go ahead and send it",
  "do it",
  "do it now",
  "send",
  "send it",
  "confirm it",
  "confirm send",
  "sounds good",
  "please do",
  "please send",
  "yes please",
  "yes confirm",
  "yes send it",
  "ok go ahead",
]);

// If any of these appear the user is hedging, redirecting, or asking a question
// rather than plainly confirming — they veto a match even next to a "yes".
const NEGATION =
  /\b(no|nope|nah|not|n't|never|stop|cancel|wait|hold|but|however|instead|actually|maybe|unless|what|why|how|when|where|who|which|whose)\b/;

/**
 * Treats a user message as confirmation of the destructive action the agent just
 * proposed. Deliberately strict — a turn-wide affirmation opens the gate, so a
 * false positive ("yes but don't send it", "ok what's on my calendar?") would
 * fire a real send/delete. Matches only a bare affirmation, or a <=4-word
 * utterance that starts with one and carries no negation/redirection.
 */
export function isAffirmation(text: string | undefined | null): boolean {
  if (!text) return false;
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ") // punctuation -> space (keep the apostrophe)
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;
  if (NEGATION.test(normalized)) return false;
  if (AFFIRM_PHRASES.has(normalized)) return true;
  // "yes send it", "ok go ahead", "sure do it" — bounded so prose can't sneak in.
  const words = normalized.split(" ");
  return words.length <= 4 && AFFIRM_WORDS.includes(words[0]!);
}
