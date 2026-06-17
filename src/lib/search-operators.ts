/**
 * Gmail-style search operators, parsed into filters for Corsair's
 * `tenant.gmail.db.messages.search()` API. Supports field operators
 * (`from:`, `to:`, `subject:`), status flags (`is:unread|read|starred|unstarred`)
 * and free text. Pure and dependency-free so it is shared by the server (which
 * builds the Corsair query) and the client (which renders the parsed chips).
 *
 * Example: `from:alice subject:"q3 invoice" is:unread budget`
 *   → from contains "alice", subject contains "q3 invoice", unread, text "budget".
 */
export type ParsedQuery = {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  isUnread?: boolean;
  isRead?: boolean;
  isStarred?: boolean; // true = starred, false = unstarred
};

const FLAG_RE = /\bis:(unread|read|starred|unstarred)\b/gi;
const FIELD_RE = /\b(from|to|subject):(?:"([^"]*)"|(\S+))/gi;

export function parseQuery(raw: string): ParsedQuery {
  const q: ParsedQuery = {};
  let rest = raw;

  rest = rest.replace(FLAG_RE, (_m, flag: string) => {
    switch (flag.toLowerCase()) {
      case "unread":
        q.isUnread = true;
        break;
      case "read":
        q.isRead = true;
        break;
      case "starred":
        q.isStarred = true;
        break;
      case "unstarred":
        q.isStarred = false;
        break;
    }
    return " ";
  });

  rest = rest.replace(FIELD_RE, (_m, field: string, quoted?: string, single?: string) => {
    const value = (quoted ?? single ?? "").trim();
    if (value) {
      q[field.toLowerCase() as "from" | "to" | "subject"] = value;
    }
    return " ";
  });

  const text = rest.replace(/\s+/g, " ").trim();
  if (text) q.text = text;
  return q;
}

type Contains = { contains: string };
type FilterField = "from" | "to" | "subject" | "snippet";
export type MessageFilter = Partial<Record<FilterField, Contains>>;

/**
 * Builds the `data` filter object(s) for `gmail.db.messages.search`. Field
 * operators are ANDed within one object; free text becomes one object per text
 * field (subject/snippet/from), so it matches ANY of them while still ANDing the
 * field operators. Returns [] when the query has only flags (or nothing) — the
 * caller then lists the window and applies the flags itself.
 */
export function buildFilters(q: ParsedQuery): MessageFilter[] {
  const base: MessageFilter = {};
  if (q.from) base.from = { contains: q.from };
  if (q.to) base.to = { contains: q.to };
  if (q.subject) base.subject = { contains: q.subject };

  if (q.text) {
    const text = q.text;
    // Free text matches ANY of these fields, ANDed with the operators above.
    // Skip a field already pinned by an operator so the text can't overwrite it
    // (snippet is never an operator, so the result is always non-empty).
    const fields = (["subject", "snippet", "from"] as const).filter(
      (field) => !base[field],
    );
    return fields.map((field) => ({ ...base, [field]: { contains: text } }));
  }
  return Object.keys(base).length > 0 ? [base] : [];
}

/** Post-filter for the label-derived flags (labels aren't a searchable field). */
export function matchesFlags(
  m: { unread: boolean; starred: boolean },
  q: ParsedQuery,
): boolean {
  if (q.isUnread && !m.unread) return false;
  if (q.isRead && m.unread) return false;
  if (q.isStarred === true && !m.starred) return false;
  if (q.isStarred === false && m.starred) return false;
  return true;
}

/**
 * Adaptive keyword boost added on top of a message's semantic similarity score.
 * Chosen by an offline eval over the real mailbox (TIERED beat pure semantic and
 * every static fusion): a strong lift when the free text appears verbatim in the
 * subject, a medium lift when every term is present, a scaled lift for partial
 * overlap, and ZERO otherwise — so paraphrase/conceptual queries (no real overlap)
 * stay pure-semantic and never pick up keyword noise.
 */
export function tieredBoost(
  text: string,
  m: { subject: string; snippet: string; from: string },
): number {
  if (!text) return 0;
  const phrase = text.toLowerCase();
  const subject = m.subject.toLowerCase();
  if (phrase.length >= 3 && subject.includes(phrase)) return 0.35;
  const hay = `${subject} ${m.snippet.toLowerCase()} ${m.from.toLowerCase()}`;
  const tokens = [...new Set(phrase.split(/\s+/).filter((t) => t.length >= 2))];
  if (tokens.length === 0) return 0;
  const frac = tokens.filter((t) => hay.includes(t)).length / tokens.length;
  if (frac >= 0.999) return 0.2;
  if (frac >= 0.6) return 0.2 * frac;
  return 0;
}

/** Field-operator filter: a message must contain each from:/to:/subject: value. */
export function matchesOperators(
  m: { from: string; to: string; subject: string },
  q: ParsedQuery,
): boolean {
  const has = (hay: string, needle?: string) =>
    !needle || hay.toLowerCase().includes(needle.toLowerCase());
  return has(m.from, q.from) && has(m.to, q.to) && has(m.subject, q.subject);
}

/** True when the query carries any actionable filter. */
export function hasFilters(q: ParsedQuery): boolean {
  return (
    q.from !== undefined ||
    q.to !== undefined ||
    q.subject !== undefined ||
    q.text !== undefined ||
    q.isUnread === true ||
    q.isRead === true ||
    q.isStarred !== undefined
  );
}

/** Human-readable chips for the search bar, e.g. `from: alice`, `unread`. */
export function queryChips(q: ParsedQuery): { key: string; label: string }[] {
  const chips: { key: string; label: string }[] = [];
  if (q.from) chips.push({ key: "from", label: `from: ${q.from}` });
  if (q.to) chips.push({ key: "to", label: `to: ${q.to}` });
  if (q.subject) chips.push({ key: "subject", label: `subject: ${q.subject}` });
  if (q.isUnread) chips.push({ key: "unread", label: "unread" });
  if (q.isRead) chips.push({ key: "read", label: "read" });
  if (q.isStarred === true) chips.push({ key: "starred", label: "starred" });
  if (q.isStarred === false) chips.push({ key: "unstarred", label: "unstarred" });
  if (q.text) chips.push({ key: "text", label: `“${q.text}”` });
  return chips;
}
