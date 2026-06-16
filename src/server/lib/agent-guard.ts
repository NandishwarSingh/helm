import "server-only";

/**
 * Per-request call guard for the agent's tools. It enforces three things so a
 * single request can't loop or double-act:
 *  - exact-argument memo: an identical call returns the earlier result;
 *  - read budget: each non-write tool may run only so many times;
 *  - write fingerprints: a second content-creating write for the same
 *    recipient/subject (even with a reworded body) is refused.
 * It holds no I/O — the tool's own work is the `fn` passed to `run`.
 */
export type GuardResult<O> =
  | O
  | { repeatedCall: true; note: string; previousResult: unknown }
  | { error: string };

export function createCallGuard(opts: {
  readBudget: number;
  writeTools: Set<string>;
}) {
  const memo = new Map<string, unknown>();
  const counts = new Map<string, number>();
  const writeSignatures = new Map<string, unknown>();

  return async function run<I, O>(
    name: string,
    input: I,
    fn: (input: I) => Promise<O>,
    signature?: (input: I) => string,
  ): Promise<GuardResult<O>> {
    const key = `${name}:${JSON.stringify(input)}`;
    if (memo.has(key)) {
      return {
        repeatedCall: true,
        note: "You already called this tool with identical arguments. Reuse the earlier result; do not call it again.",
        previousResult: memo.get(key),
      };
    }
    const sig = signature?.(input);
    if (sig && writeSignatures.has(sig)) {
      return {
        repeatedCall: true,
        note: "You already created this for the same recipient and subject earlier in this request. Do not create it again; reuse the earlier result.",
        previousResult: writeSignatures.get(sig),
      };
    }
    const used = counts.get(name) ?? 0;
    if (!opts.writeTools.has(name) && used >= opts.readBudget) {
      return {
        error: `You have already called ${name} ${used} times this request. Stop investigating: act on what you have, then write your final answer.`,
      };
    }
    counts.set(name, used + 1);
    try {
      const result = await fn(input);
      memo.set(key, result);
      if (sig) writeSignatures.set(sig, result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed";
      memo.set(key, { error: message });
      return { error: message.slice(0, 200) };
    }
  };
}
