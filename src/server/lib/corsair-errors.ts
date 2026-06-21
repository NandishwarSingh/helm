import "server-only";
/**
 * Before a tenant has connected Google, Corsair's cache reads throw rather
 * than returning empty. Treat that "not connected yet" state as an empty
 * result so the UI can show an onboarding prompt instead of a server error.
 */
export function isNotConnectedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found\. make sure to create the integration|integration ".*" not found|no account|not authenticated|unauthor/i.test(
    message,
  );
}

/**
 * The account WAS connected but its Google OAuth refresh token is now dead
 * (expired/revoked) — Google returns `invalid_grant`, surfaced by Corsair as
 * "Failed to obtain/refresh ... access token". Distinct from
 * `isNotConnectedError` (never connected): the fix is to RECONNECT, and the user
 * must be told — never silently swallow it or let the agent invent data for the
 * account. Common when the OAuth app is in Testing mode (7-day token expiry).
 */
export function isAuthExpiredError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /invalid_grant|expired or revoked|failed to (obtain|refresh)[^.]*access token/i.test(
    message,
  );
}

/** Runs a cache read, returning [] when the tenant has not connected yet. */
export async function listOrEmpty<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch (error) {
    if (isNotConnectedError(error)) return [];
    throw error;
  }
}
