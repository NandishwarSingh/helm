import "server-only";

/** A record the agent's answer drew on, cited at the end of the reply. */
export type HelmSource = {
  kind: "email" | "event";
  id: string;
  accountId: string;
  account: string; // display email; "" when unknown / single-account
  title: string;
  from?: string;
  date?: string;
};

type AccountRef = { accountId: string; email: string };

/**
 * Collects the email/event rows a `run_script` actually RETURNED, so the answer
 * cites real records, never hallucinated ones. Only rows shaped like the
 * playbook's returns (an `id`/`entity_id` plus a subject or summary) are kept;
 * each resolves to its account (by the `account` email the script tags, else the
 * scope account). `resolve()` dedupes by (accountId,id) and caps the list.
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
    if (!title) return null; // need a display title — skip shapeless objects
    const isEvent = !subject && (Boolean(summary) || Boolean(row.start));
    const accountEmail = str(row.account);
    const matched = accountEmail
      ? emailToId.get(accountEmail.toLowerCase())
      : undefined;
    const accountId = matched ?? scopeAccountId;
    const date = str(row.date) || str(row.start);
    return {
      kind: isEvent ? "event" : "email",
      id,
      accountId,
      account: accountEmail,
      title,
      from: isEvent ? undefined : str(row.from) || undefined,
      date: date || undefined,
    };
  }

  function harvest(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) harvest(item);
      return;
    }
    if (value && typeof value === "object") {
      const row = value as Record<string, unknown>;
      const src = rowToSource(row);
      if (src) pool.set(`${src.accountId}:${src.id}`, src);
      // Follow array-valued fields (a wrapper like { inbox: [...] }) one level;
      // never recurse a row's scalar fields. run_script returns are JSON (no
      // cycles), so this terminates.
      for (const v of Object.values(row)) {
        if (Array.isArray(v)) harvest(v);
      }
    }
  }

  function resolve(): HelmSource[] {
    return Array.from(pool.values()).slice(0, 8);
  }

  return { harvest, resolve };
}
