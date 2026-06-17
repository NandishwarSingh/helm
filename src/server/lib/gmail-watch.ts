import "server-only";

import { eq } from "drizzle-orm";

import { corsair } from "@/server/corsair";
import { db } from "@/server/db";
import { gmailWatch } from "@/server/db/schema";

/**
 * Multi-tenant Gmail watch management. A Gmail watch expires in ~7 days and the
 * Pub/Sub push only carries the mailbox's emailAddress, so we keep an
 * email -> tenant map: the webhook routes each push to the right tenant's
 * realtime stream, and the renewal cron re-arms every connected tenant's watch.
 *
 * Corsair's Gmail plugin exposes neither users.watch nor users.getProfile, so we
 * call Gmail directly with the access token Corsair manages (a cheap api call
 * forces a refresh + persist first, then `keys.get_access_token()` returns it).
 */
const GMAIL_TOPIC =
  process.env.GMAIL_PUBSUB_TOPIC ?? "projects/helm-499111/topics/helm-gmail";

async function freshAccessToken(tenantId: string): Promise<string> {
  const tenant = corsair.withTenant(tenantId);
  // Forces Corsair to refresh + persist a current access token.
  await tenant.gmail.api.messages.list({ maxResults: 1 });
  const token = await tenant.gmail.keys.get_access_token();
  if (!token) throw new Error(`no Gmail access token for tenant ${tenantId}`);
  return token;
}

/** The connected Gmail address for a tenant (the plugin has no profile op). */
export async function getGmailEmail(tenantId: string): Promise<string | null> {
  try {
    const token = await freshAccessToken(tenantId);
    const res = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { emailAddress?: string };
    return data.emailAddress?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/** Re-arm (or first-register) the Gmail watch; returns the expiration ms or null. */
export async function armGmailWatch(tenantId: string): Promise<number | null> {
  try {
    const token = await freshAccessToken(tenantId);
    const res = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/watch",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ topicName: GMAIL_TOPIC, labelIds: ["INBOX"] }),
      },
    );
    if (!res.ok) {
      console.error("[gmail-watch] arm failed:", res.status);
      return null;
    }
    const data = (await res.json()) as { expiration?: string };
    return data.expiration ? Number(data.expiration) : null;
  } catch (error) {
    console.error(
      "[gmail-watch] arm error:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/** Records (email -> tenant) so future pushes for this mailbox route correctly. */
export async function rememberGmailTenant(
  tenantId: string,
  email: string,
): Promise<void> {
  await db
    .insert(gmailWatch)
    .values({ email: email.toLowerCase(), tenantId })
    .onConflictDoUpdate({
      target: gmailWatch.email,
      set: { tenantId, updatedAt: new Date() },
    });
}

/** The tenant that owns a Gmail address, if any. */
export async function tenantForEmail(email: string): Promise<string | null> {
  const [row] = await db
    .select({ tenantId: gmailWatch.tenantId })
    .from(gmailWatch)
    .where(eq(gmailWatch.email, email.toLowerCase()));
  return row?.tenantId ?? null;
}

/** Every tenant with a registered Gmail watch (for the renewal cron). */
export async function allWatchTenants(): Promise<string[]> {
  const rows = await db.select({ tenantId: gmailWatch.tenantId }).from(gmailWatch);
  return [...new Set(rows.map((row) => row.tenantId))];
}

/**
 * Pull the emailAddress out of a Gmail Pub/Sub push body. The push is
 * `{ message: { data: base64(JSON {emailAddress, historyId}) }, subscription }`.
 * Returns null for non-Gmail pushes (e.g. Calendar channels) or malformed input.
 */
export function gmailPushEmail(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const message = (body as { message?: { data?: string } }).message;
  if (!message?.data) return null;
  try {
    const decoded = Buffer.from(message.data, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as { emailAddress?: string };
    return parsed.emailAddress?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}
