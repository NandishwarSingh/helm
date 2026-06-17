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
