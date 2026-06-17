import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Action-fingerprinted agent confirmation.
 *
 * When the agent stages a destructive op (send/trash/delete/calendar write), the
 * server captures the EXACT operation + arguments, HMAC-signs them into a token,
 * and shows the user a confirmation card derived from those same arguments. On
 * "Confirm" the server replays the signed action verbatim — the model never gets
 * to re-issue it, so a plain "yes" (or a prompt-injected one) can't authorize a
 * different write than the one the user saw. Mirrors the oauth-state /
 * session-token HMAC pattern; kept dependency-free so it unit-tests directly.
 */

const ACTION_MAX_AGE_MS = 10 * 60 * 1000;

/** The captured op the user is asked to confirm: a Corsair dot-path + its args. */
export type ProposedAction = {
  tenantId: string;
  op: string;
  args: unknown;
  /**
   * Email of the mailbox/calendar the op targets, when the agent named one via
   * `corsair.account("…")`. Undefined ⇒ the session's active account. Carried in
   * the signed token so the confirmed action replays on the right mailbox.
   */
  targetAccount?: string;
};

function sign(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

/** HMAC-signs the action into a "<payload>.<sig>" token, stamped with `nowMs`. */
export function signAction(
  secret: string,
  action: ProposedAction,
  nowMs: number,
): string {
  const payload = Buffer.from(
    JSON.stringify({
      t: action.tenantId,
      o: action.op,
      a: action.args ?? null,
      ta: action.targetAccount ?? null,
      n: nowMs,
    }),
  ).toString("base64url");
  return `${payload}.${sign(secret, payload)}`;
}

/** Returns the action, or null if tampered, malformed, or older than 10 minutes. */
export function verifyAction(
  secret: string,
  token: string | undefined | null,
  nowMs: number,
): ProposedAction | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(secret, payload));
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }
  try {
    const o = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      t?: string;
      o?: string;
      a?: unknown;
      ta?: string | null;
      n?: number;
    };
    if (!o.t || !o.o || typeof o.n !== "number") return null;
    if (nowMs - o.n > ACTION_MAX_AGE_MS) return null;
    return { tenantId: o.t, op: o.o, args: o.a, targetAccount: o.ta ?? undefined };
  } catch {
    return null;
  }
}

/** One labelled line on the confirmation card. */
export type ActionField = { label: string; value: string };

/** The human-readable card, derived ONLY from the exact args that will run. */
export type ActionSummary = {
  kind:
    | "send"
    | "trash"
    | "delete"
    | "event-create"
    | "event-update"
    | "event-delete"
    | "other";
  title: string;
  fields: ActionField[];
  body?: string;
};

/** Decode a base64url MIME blob and split it into headers + body. */
function parseMime(raw: string): {
  to: string;
  cc: string;
  bcc: string;
  replyTo: string;
  subject: string;
  body: string;
} | null {
  let text: string;
  try {
    text = Buffer.from(
      raw.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
  } catch {
    return null;
  }
  if (!text) return null;
  const sep = text.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
  const idx = text.indexOf(sep);
  const head = idx >= 0 ? text.slice(0, idx) : text;
  const body = idx >= 0 ? text.slice(idx + sep.length) : "";
  const header = (name: string): string => {
    const re = new RegExp(`^${name}:\\s*(.*)$`, "im");
    return re.exec(head)?.[1]?.trim() ?? "";
  };
  return {
    to: header("To"),
    cc: header("Cc"),
    bcc: header("Bcc"),
    replyTo: header("Reply-To"),
    subject: header("Subject"),
    body,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Coerce an unknown to a display string — primitives only; objects → "". */
function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

/** First non-empty display string among the candidates, else the fallback. */
function pick(fallback: string, ...values: unknown[]): string {
  for (const value of values) {
    const s = str(value);
    if (s.length > 0) return s;
  }
  return fallback;
}

/** True if `op`'s dot-path ends with any of the given suffixes. */
function opEndsWith(op: string, ...suffixes: string[]): boolean {
  return suffixes.some((s) => op.endsWith(s));
}

/**
 * Turn a captured `(op, args)` into the card the user confirms. The summary is a
 * pure function of the SAME args that will be replayed, so "what you see" and
 * "what runs" can never diverge.
 */
export function summarizeAction(op: string, args: unknown): ActionSummary {
  const a = asRecord(args);

  if (opEndsWith(op, "messages.send")) {
    const mime = typeof a.raw === "string" ? parseMime(a.raw) : null;
    const fields: ActionField[] = [{ label: "To", value: pick("—", mime?.to) }];
    if (mime?.cc) fields.push({ label: "Cc", value: mime.cc });
    // Bcc and Reply-To change WHO receives the mail — surface them so the card
    // is faithful to the raw that will actually be sent.
    if (mime?.bcc) fields.push({ label: "Bcc", value: mime.bcc });
    if (mime?.replyTo) fields.push({ label: "Reply-To", value: mime.replyTo });
    fields.push({ label: "Subject", value: pick("(no subject)", mime?.subject) });
    const body = mime ? mime.body.trim().slice(0, 800) : "";
    return {
      kind: "send",
      title: "Send email",
      fields,
      body: body.length > 0 ? body : undefined,
    };
  }

  if (opEndsWith(op, "messages.trash")) {
    return {
      kind: "trash",
      title: "Move email to Trash",
      fields: [{ label: "Message", value: pick("—", a.id) }],
    };
  }

  if (opEndsWith(op, "messages.delete", "messages.batchDelete")) {
    const ids = Array.isArray(a.ids)
      ? a.ids.map(str).filter(Boolean).join(", ")
      : str(a.id);
    return {
      kind: "delete",
      title: "Permanently delete email",
      fields: [{ label: "Message", value: ids.length > 0 ? ids : "—" }],
    };
  }

  if (opEndsWith(op, "events.create", "events.insert")) {
    return {
      kind: "event-create",
      title: "Create calendar event",
      ...eventFields(asRecord(a.event ?? a)),
    };
  }

  if (opEndsWith(op, "events.update", "events.patch")) {
    return {
      kind: "event-update",
      title: "Update calendar event",
      ...eventFields(asRecord(a.event ?? a)),
    };
  }

  if (opEndsWith(op, "events.delete", "events.move")) {
    return {
      kind: "event-delete",
      title: "Delete calendar event",
      fields: [{ label: "Event", value: pick("—", a.id, a.eventId) }],
    };
  }

  return {
    kind: "other",
    title: "Confirm action",
    fields: [{ label: "Operation", value: op }],
  };
}

/** Shared event field extraction for create/update cards. */
function eventFields(e: Record<string, unknown>): {
  fields: ActionField[];
  body?: string;
} {
  const start = asRecord(e.start);
  const end = asRecord(e.end);
  const fields: ActionField[] = [
    { label: "Title", value: pick("(untitled)", e.summary) },
  ];
  const startVal = pick("", start.dateTime, start.date);
  const endVal = pick("", end.dateTime, end.date);
  if (startVal) fields.push({ label: "Start", value: startVal });
  if (endVal) fields.push({ label: "End", value: endVal });
  const attendees = Array.isArray(e.attendees)
    ? e.attendees.map((x) => str(asRecord(x).email)).filter(Boolean)
    : [];
  if (attendees.length) {
    fields.push({ label: "Invites", value: attendees.join(", ") });
  }
  const description = typeof e.description === "string" ? e.description : "";
  const body = description.trim().slice(0, 600);
  return { fields, body: body.length > 0 ? body : undefined };
}
