/**
 * Pure security policy for the agent's `run_script` tool — the two decisions
 * that gate every write to the user's real account:
 *
 *   1. isAllowedPath  — is this Corsair operation on the allowlist at all?
 *   2. isDestructive  — does it send/change/delete something outward-facing?
 *
 * A destructive op is never executed inline: the sandbox captures it, the route
 * signs it and shows the user a confirmation card, and only an explicit approval
 * replays it verbatim (see agent-action). These live in their own dependency-free
 * module (no `server-only`, no Corsair, no isolated-vm) so they unit-test directly.
 */

/** Only `gmail`/`googlecalendar` `.api`/`.db` operations may run from a script. */
export const ALLOWED_PATH = /^(gmail|googlecalendar)\.(api|db)\.[a-zA-Z0-9_.]+$/;

/**
 * Path segments that name the prototype chain rather than a real Corsair op.
 * `[a-zA-Z0-9_.]+` would otherwise admit `gmail.api.messages.constructor`, which
 * the bridge would walk to a callable on the prototype. Reject them so a path
 * can only ever resolve to an own operation.
 */
const RESERVED_SEGMENT = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "valueOf",
]);

export function isAllowedPath(path: string): boolean {
  if (!ALLOWED_PATH.test(path)) return false;
  return path.split(".").every((seg) => !RESERVED_SEGMENT.has(seg));
}

/**
 * Outward-facing or irreversible operations the agent must never perform without
 * the user's explicit confirmation: sending mail, sending/overwriting/deleting a
 * draft, trashing/deleting/untrashing mail or whole threads, mutating the label
 * taxonomy, and any calendar write (which can fire real invites). Reads and
 * *creating* a draft (a benign save) are intentionally absent — always allowed,
 * as are messages/threads.modify (reversible single-message label toggles). The
 * allowlist (`ALLOWED_PATH`) admits every Corsair leaf, so any mutating op NOT
 * listed here would run unconfirmed — keep this in sync with the Corsair surface.
 * `batchModify` IS gated even though single `modify` isn't: a bulk label write
 * can move many messages to Trash/Spam at once, so its blast radius warrants a
 * confirmation a one-off toggle doesn't.
 */
export const DESTRUCTIVE = [
  /^gmail\.api\.messages\.(send|trash|delete|batchDelete|batchModify|untrash)$/,
  /^gmail\.api\.threads\.(trash|delete|untrash)$/,
  /^gmail\.api\.drafts\.(send|update|delete)$/,
  /^gmail\.api\.labels\.(create|update|delete)$/,
  /^googlecalendar\.api\.events\.(insert|create|update|patch|delete|move)$/,
];

export function isDestructive(path: string): boolean {
  return DESTRUCTIVE.some((re) => re.test(path));
}
