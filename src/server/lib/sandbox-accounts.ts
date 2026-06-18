/**
 * Pure account-targeting for the run_script sandbox — deliberately free of
 * isolated-vm so the ownership gate can be unit-tested. `resolveAccountTarget`
 * is the single authorization point for `corsair.account("email")`: a non-empty
 * email MUST be one of the session's own connected accounts, else it fails
 * closed. The sandbox can therefore never reach a tenant outside the session.
 */

export type TenantCorsair = Record<string, unknown>;

/** A connected account the sandbox may target by email via corsair.account(). */
export type AccountBridge = { email: string; client: TenantCorsair };

export type AccountResolution =
  | { ok: true; client: TenantCorsair }
  | { ok: false; error: string };

/**
 * Resolve `corsair.account(email)` to a connected mailbox/calendar client. Empty
 * email => the active account. A non-empty email is matched against the
 * session's OWN list; an unknown email fails closed.
 */
export function resolveAccountTarget(
  accounts: AccountBridge[],
  active: TenantCorsair,
  accountEmail: string,
): AccountResolution {
  if (!accountEmail) return { ok: true, client: active };
  const match = accounts.find((a) => a.email === accountEmail);
  if (!match) {
    return {
      ok: false,
      error: `unknown account: "${accountEmail}" is not one of your connected accounts`,
    };
  }
  return { ok: true, client: match.client };
}
