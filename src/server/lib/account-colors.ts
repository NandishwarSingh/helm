import "server-only";

/**
 * A small palette so each connected account gets a visually distinct dot. The
 * palette is larger than MAX_ACCOUNTS (6), so a free colour always exists.
 */
export const ACCOUNT_COLORS = [
  "#38bdf8", // sky
  "#34d399", // emerald
  "#f59e0b", // amber
  "#f472b6", // pink
  "#a78bfa", // violet
  "#fb7185", // rose
  "#22d3ee", // cyan
] as const;

const PALETTE: readonly string[] = ACCOUNT_COLORS;

/** First palette colour not already taken — for assigning a new account a dot. */
export function pickUnusedColor(used: Iterable<string | null | undefined>): string {
  const taken = new Set<string>();
  for (const c of used) if (c) taken.add(c);
  return PALETTE.find((c) => !taken.has(c)) ?? ACCOUNT_COLORS[0];
}

/**
 * Enforce the invariant that no two of a user's accounts ever share a colour.
 * Keeps an account's stored colour when it's a valid palette entry not yet taken
 * by an earlier account (stable across renders); otherwise hands out the next
 * free palette colour. Falls back to round-robin only if the palette is somehow
 * exhausted. Self-heals existing collisions at read time — no migration needed.
 */
export function assignUniqueColors<T extends { color: string | null }>(
  accounts: T[],
): (Omit<T, "color"> & { color: string })[] {
  const used = new Set<string>();
  return accounts.map((a, i) => {
    let color =
      a.color && PALETTE.includes(a.color) && !used.has(a.color)
        ? a.color
        : PALETTE.find((c) => !used.has(c));
    color ??= ACCOUNT_COLORS[i % ACCOUNT_COLORS.length]!;
    used.add(color);
    return { ...a, color };
  });
}
