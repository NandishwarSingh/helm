import "server-only";

import ivm from "isolated-vm";

import {
  isAllowedPath,
  isBlockedWrite,
  isDestructive,
} from "@/server/lib/agent-policy";
import { isAuthExpiredError } from "@/server/lib/corsair-errors";
import {
  resolveAccountTarget,
  type AccountBridge,
  type TenantCorsair,
} from "@/server/lib/sandbox-accounts";

/**
 * Runs the agent's `run_script` code inside an isolated-vm V8 isolate.
 *
 * The isolate is bare — no `process`, `require`, `fetch`, `fs`, `Buffer`, no
 * host globals at all — so a prompt-injected script can't read secrets, touch
 * the filesystem, or reach the network. The ONE capability we hand in is an
 * allowlisted, tenant-scoped `corsair` bridge: the script can call
 * `corsair.gmail.api.*`, `corsair.gmail.db.*` and `corsair.googlecalendar.api.*`
 * (and `.db.*`), and nothing else. Arguments and results cross the boundary as
 * JSON, never as live objects, so there is no reference the script can climb
 * back to the host through.
 */

// The allowlist + destructive-op policy live in agent-policy (pure + tested).
const MEMORY_LIMIT_MB = 128;
const SYNC_TIMEOUT_MS = 8_000; // CPU time for one synchronous turn in the isolate
const OVERALL_TIMEOUT_MS = 20_000; // wall-clock ceiling incl. awaited Corsair calls
const MAX_RESULT_BYTES = 512 * 1024; // per Corsair call; reduce a `limit:` if hit
const MAX_ARG_BYTES = 512 * 1024; // per Corsair call's args — caps host-ward copy
// Bounds host-side work per script: `arguments:{copy:true}` deep-copies every
// arg into the NODE heap (outside the isolate's memory limit), so an await-loop
// of huge calls could OOM/hammer the DB within the 20s wall-clock. Cap the count.
const MAX_HOST_CALLS = 80;

/**
 * Builds a recursive `corsair` Proxy inside the isolate. Property access
 * accumulates the dot-path; calling a leaf forwards (path, args) to the host
 * bridge `__corsairCall` and parses the JSON result. Pure ECMAScript — it uses
 * only Proxy/JSON, both of which exist in a bare isolate.
 */
const BOOTSTRAP = `
globalThis.corsair = (function () {
  var accounts = JSON.parse(__corsairAccountsJson || "[]");
  function make(path, account) {
    return new Proxy(function () {}, {
      get: function (_t, prop) {
        if (typeof prop !== "string") return undefined;
        // corsair.account("email") -> the same ops scoped to that connected
        // mailbox/calendar; corsair.accounts -> the list of connected emails.
        if (path === "" && prop === "account") {
          return function (email) { return make("", String(email)); };
        }
        if (path === "" && prop === "accounts") {
          return accounts.slice();
        }
        return make(path ? path + "." + prop : prop, account);
      },
      apply: function (_t, _this, args) {
        var argsJson = JSON.stringify(args.length ? args[0] : {});
        return __corsairCall
          .apply(undefined, [path, argsJson, account || ""], {
            result: { promise: true, copy: true },
            arguments: { copy: true },
          })
          .then(function (resJson) {
            var res = JSON.parse(resJson);
            if (!res.ok) throw new Error(res.error);
            return res.data;
          });
      },
    });
  }
  return make("", "");
})();
void 0;
`;

type ScriptResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/**
 * The destructive-op gate for one agent turn. `confirmed` is whether the user
 * affirmed the proposed action; `budget.remaining` is how many destructive ops
 * are still authorized. The SAME object is threaded through every run_script
 * call in the turn, so the cap is per-confirmation — not per-call, which would
 * reset on each fresh isolate and let one "yes" fire several writes.
 */
export type DestructiveGate = {
  confirmed: boolean;
  budget: { remaining: number };
  /**
   * The first destructive op the model stages this turn, captured (op + args)
   * for the confirmation card. Set only on a preview turn (confirmed === false);
   * the route signs it, the user approves it, and the action is replayed verbatim.
   */
  proposed?: { op: string; args: unknown; targetAccount?: string };
};

export async function runScriptSandboxed(
  tenant: TenantCorsair,
  code: string,
  gate: DestructiveGate = { confirmed: false, budget: { remaining: 0 } },
  accounts: AccountBridge[] = [],
): Promise<ScriptResult> {
  const isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB });
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Per-script host-call budget — see MAX_HOST_CALLS.
  let hostCalls = 0;

  // The host side of the bridge: validate the path against the allowlist,
  // resolve the method on the tenant-scoped Corsair client, call it, and hand
  // back a JSON envelope. It ALWAYS resolves (never rejects across the isolate
  // boundary — that would surface as an uncaught host rejection); errors travel
  // as `{ ok: false, error }` and are re-thrown inside the isolate by the proxy.
  const fail = (error: string) => JSON.stringify({ ok: false, error });
  const hostCall = async (
    pathStr: string,
    argsJson: string,
    accountEmail: string,
  ): Promise<string> => {
    try {
      if (++hostCalls > MAX_HOST_CALLS) {
        return fail(
          `too many operations in one script (limit ${MAX_HOST_CALLS}) — batch your reads and cap list sizes; do not loop over the same call`,
        );
      }
      if (argsJson.length > MAX_ARG_BYTES) {
        return fail("arguments too large — pass only the fields the operation needs");
      }
      if (!isAllowedPath(pathStr)) return fail(`operation not allowed: ${pathStr}`);
      // Resolve the target mailbox. A named account (corsair.account("email"))
      // must be one the user OWNS — `accounts` is the session's own list, so the
      // sandbox can never reach a tenant outside it. Empty => the active account.
      const resolved = resolveAccountTarget(accounts, tenant, accountEmail);
      if (!resolved.ok) return fail(resolved.error);
      const target = resolved.client;
      if (isDestructive(pathStr)) {
        if (!gate.confirmed) {
          // Capture the first staged action for the confirmation card, then
          // refuse. The user approves it on the card and the server replays the
          // signed action verbatim — the model never executes it directly.
          if (!gate.proposed) {
            try {
              gate.proposed = {
                op: pathStr,
                args: argsJson ? (JSON.parse(argsJson) as unknown) : {},
                targetAccount: accountEmail || undefined,
              };
            } catch {
              gate.proposed = {
                op: pathStr,
                args: {},
                targetAccount: accountEmail || undefined,
              };
            }
          }
          return fail(
            `CONFIRM_REQUIRED: "${pathStr}" is now STAGED for the user to confirm on a card. This is expected — do NOT retry it, do NOT catch/swallow this, and do NOT fabricate a result: the action did NOT run and will only run after the user clicks Confirm. Write ONE short sentence telling the user exactly what you staged.`,
          );
        }
        // Shared across every run_script call this turn, so one confirmation
        // can't authorize more than the budget no matter how the model splits
        // the work across steps.
        if (gate.budget.remaining <= 0) {
          return fail(
            `CONFIRM_REQUIRED: only one confirmed action is allowed per message, and "${pathStr}" would be another. Tell the user what remains and ask them to confirm it separately.`,
          );
        }
        gate.budget.remaining -= 1;
      } else if (isBlockedWrite(pathStr)) {
        // Fail closed: a mutating op that is neither an explicitly-handled
        // destructive op (staged above) nor a known-benign write must NOT run —
        // closes the denylist gap where e.g. settings.updateAutoForwarding /
        // acl.insert / calendars.clear would otherwise execute unconfirmed.
        return fail(
          `operation not permitted: "${pathStr}" is a write Helm's agent can't perform. Only reading, sending/replying, drafts, trashing/deleting mail, label toggles, and calendar events are available — tell the user this isn't supported.`,
        );
      }
      const parts = pathStr.split(".");
      const method = parts.pop()!;
      let parent: unknown = target;
      for (const key of parts) {
        parent = (parent as Record<string, unknown> | undefined)?.[key];
        if (parent == null) return fail(`unknown operation: ${pathStr}`);
      }
      const fn = (parent as Record<string, unknown>)?.[method];
      if (typeof fn !== "function") return fail(`not callable: ${pathStr}`);
      const args = argsJson ? (JSON.parse(argsJson) as unknown) : {};
      const result = await (fn as (a: unknown) => unknown).call(parent, args);
      const dataJson = JSON.stringify(result === undefined ? null : result);
      if (dataJson.length > MAX_RESULT_BYTES) {
        // The cap is on THIS operation's raw return, before your script can touch
        // it — so filtering in JS won't help. Call it again with a much smaller
        // `limit:` (e.g. 25) and map to only the fields you need.
        return fail("result too large — call this operation again with a smaller `limit:` (e.g. limit: 25); a single account rarely needs more than 50 rows to find recent mail");
      }
      return `{"ok":true,"data":${dataJson}}`;
    } catch (err) {
      if (isAuthExpiredError(err)) {
        return fail(
          `account connection expired — this mailbox must be reconnected by the user (its Google access token is no longer valid). Report this account as needing reconnection; do NOT retry, and do NOT fabricate or guess its mail/events.`,
        );
      }
      return fail(err instanceof Error ? err.message : String(err));
    }
  };

  try {
    const context = await isolate.createContext();
    await context.global.set("__corsairCall", new ivm.Reference(hostCall));
    // The user's connected account emails, so the script can list them
    // (corsair.accounts) and target one (corsair.account("email")).
    await context.global.set(
      "__corsairAccountsJson",
      JSON.stringify(accounts.map((a) => a.email)),
    );
    await (await isolate.compileScript(BOOTSTRAP)).run(context);

    // Wrap the model's code so its return value is serialized out as JSON. The
    // user code runs as an async body, so `return x` works; undefined → null.
    const wrapped = `(async () => {\n${code}\n})().then((r) => JSON.stringify(r === undefined ? null : r));`;
    const script = await isolate.compileScript(wrapped);

    const runPromise = script.run(context, {
      promise: true,
      timeout: SYNC_TIMEOUT_MS,
    }) as Promise<string>;
    // If the overall-timeout below wins the race and disposes the isolate, this
    // promise rejects with nothing awaiting it. Attach a no-op handler so that
    // late rejection can't surface as an unhandledRejection (which can take down
    // the Next.js worker). The race still observes the original rejection.
    runPromise.catch(() => undefined);

    const overall = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (!isolate.isDisposed) isolate.dispose();
        reject(new Error("script timed out"));
      }, OVERALL_TIMEOUT_MS);
    });

    const resultJson = await Promise.race([runPromise, overall]);
    return { ok: true, value: resultJson ? (JSON.parse(resultJson) as unknown) : null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
    if (!isolate.isDisposed) isolate.dispose();
  }
}
