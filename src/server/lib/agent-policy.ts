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
  // Prototype-pollution / prototype-walk names.
  "__proto__",
  "prototype",
  "constructor",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  // Every inherited Object.prototype / Function.prototype callable. The host
  // walk resolves inherited members, so without these a path like
  // `gmail.api.hasOwnProperty` would resolve to a real (host) function and be
  // `.call()`-ed. Block the whole built-in surface so a path can only ever land
  // on a Corsair-defined operation, not a JS built-in.
  "valueOf",
  "toString",
  "toLocaleString",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "call",
  "apply",
  "bind",
  "caller",
  "arguments",
  "length",
  "name",
]);

export function isAllowedPath(path: string): boolean {
  if (!ALLOWED_PATH.test(path)) return false;
  return path.split(".").every((seg) => !RESERVED_SEGMENT.has(seg));
}

/**
 * Leaf verbs that mutate state. Used to FAIL CLOSED: any op whose leaf is a
 * write verb but which is neither an explicitly-handled destructive op
 * (DESTRUCTIVE, staged for confirmation) nor a known-benign write
 * (BENIGN_WRITES) is BLOCKED outright. `ALLOWED_PATH` admits every Corsair leaf,
 * so without this a mutating op the DESTRUCTIVE list forgot — Gmail
 * `settings.updateAutoForwarding` / `settings.filters.create` /
 * `settings.delegates.create` / `messages.import`, Calendar `acl.insert` /
 * `calendars.clear` — would run UNCONFIRMED via prompt injection (silent
 * mailbox/calendar takeover). Reads (get/list/getMany/search/…) are not write
 * verbs, so they're unaffected.
 */
// Prefix match (verb + optional suffix) so compound leaves are caught too —
// e.g. `update` matches `updateImap`/`updateAutoForwarding`, `create` matches
// `sendAs.create`. Read leaves (get*/list*/search/history/profile) start with
// none of these, so reads are never blocked.
const WRITE_LEAF =
  /\.(create|insert|import|update|patch|delete|batch|modify|send|trash|untrash|clear|move|stop|watch|enable|disable|setup|register|verify)\w*$/i;

/** Reversible single-item writes intentionally allowed WITHOUT confirmation. */
const BENIGN_WRITES = new Set([
  "gmail.api.drafts.create", // saving a draft is benign (not sent)
  "gmail.api.messages.modify", // reversible single-message label toggle
  "gmail.api.threads.modify", // reversible single-thread label toggle
]);

/** True if the op's leaf is a state-mutating verb. */
export function isWriteOp(path: string): boolean {
  return WRITE_LEAF.test(path);
}

/**
 * A mutating op that is NEITHER an explicitly-handled destructive op (which is
 * staged for confirmation) NOR a known-benign write — must be refused outright.
 * This is the fail-closed backstop for the denylist gap in DESTRUCTIVE.
 */
export function isBlockedWrite(path: string): boolean {
  return isWriteOp(path) && !isDestructive(path) && !BENIGN_WRITES.has(path);
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
