import "server-only";

/** A record the agent's answer drew on, cited at the end of the reply. */
export type HelmSource = {
  kind: "email" | "event";
  id: string;
  accountId: string;
  account: string; // display email; "" when not a connected mailbox / unknown
  title: string;
  from?: string;
  date?: string;
};

type AccountRef = { accountId: string; email: string };

/**
 * Collects the email/event rows a `run_script` actually RETURNED so the answer
 * cites real records, never hallucinated ones. A row is kept only when it has an
 * id + a title + a positive email/event signal (so nested label/attendee objects
 * with a stray id+subject aren't mistaken for records); once a row is taken as a
 * record we do NOT descend into its own children (no over-citing a thread's
 * messages). The display account is shown only when it resolves to a CONNECTED
 * mailbox — an attacker-tagged address is never echoed. `resolve()` caps at 8.
 */
export function createSourceRegistry(
  accounts: AccountRef[],
  scopeAccountId: string,
) {
  const emailToId = new Map(
    accounts.map((a) => [a.email.toLowerCase(), a.accountId]),
  );
  const pool = new Map<string, HelmSource>();
  const str = (v: unknown): string => (typeof v === "string" ? v : "");

  function rowToSource(row: Record<string, unknown>): HelmSource | null {
    const id = str(row.id) || str(row.entity_id);
    if (!id) return null;
    const subject = str(row.subject);
    const summary = str(row.summary);
    const title = subject || summary;
    if (!title) return null;
    const from = str(row.from);
    const hasStart = Boolean(str(row.start));
    // A real event has a start and no email markers; everything else with an
    // email signal (or a subject) is an email. Bare {id, name}-style rows fail.
    const isEvent = hasStart && !from && !row.snippet && !row.internalDate;
    const emailSignal =
      Boolean(from) ||
      Boolean(row.snippet) ||
      Boolean(row.internalDate) ||
      typeof row.ts === "number" ||
      Boolean(subject);
    if (!isEvent && !emailSignal) return null;

    const accountEmail = str(row.account);
    const matched = accountEmail
      ? emailToId.get(accountEmail.toLowerCase())
      : undefined;
    const date =
      str(row.date) ||
      str(row.start) ||
      (typeof row.ts === "number" ? new Date(row.ts).toISOString() : "");
    return {
      kind: isEvent ? "event" : "email",
      id,
      // Deep-link target: the resolved mailbox, else the scope account.
      accountId: matched ?? scopeAccountId,
      // Show ONLY a connected mailbox — never echo a model/attacker-tagged address.
      account: matched ? accountEmail : "",
      title,
      from: isEvent ? undefined : from || undefined,
      date: date || undefined,
    };
  }

  function add(src: HelmSource): void {
    // Dedupe per resolved mailbox; collapse untagged rows by id alone so a real
    // mailbox's row is never overwritten by an unknown-account one. Keep first.
    const key = src.account ? `${src.accountId}:${src.id}` : `?:${src.id}`;
    if (!pool.has(key)) pool.set(key, src);
  }

  function harvest(value: unknown, depth = 0): void {
    if (depth > 3) return; // cheap insurance; run_script returns are acyclic JSON
    if (Array.isArray(value)) {
      for (const item of value) harvest(item, depth);
      return;
    }
    if (value && typeof value === "object") {
      const row = value as Record<string, unknown>;
      const src = rowToSource(row);
      if (src) {
        add(src);
        return; // a record — don't descend into its own children
      }
      // A wrapper ({ inbox: [...] }) — descend its array fields one level deeper.
      for (const v of Object.values(row)) {
        if (Array.isArray(v)) harvest(v, depth + 1);
      }
    }
  }

  function resolve(): HelmSource[] {
    return Array.from(pool.values()).slice(0, 8);
  }

  return { harvest, resolve };
}
