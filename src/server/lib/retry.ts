import "server-only";

const TRANSIENT = /fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|aborted/i;

/**
 * Retries a call when it fails with a transient network error (Google API
 * calls through Corsair occasionally drop a connection). Non-network errors
 * are rethrown immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 2,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!TRANSIENT.test(message) || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw lastError;
}
