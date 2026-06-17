import "server-only";

import ivm from "isolated-vm";

import { isAllowedPath, isDestructive } from "@/server/lib/agent-policy";

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
const MAX_RESULT_BYTES = 256 * 1024; // per Corsair call; forces scripts to filter inline

/**
 * Builds a recursive `corsair` Proxy inside the isolate. Property access
 * accumulates the dot-path; calling a leaf forwards (path, args) to the host
 * bridge `__corsairCall` and parses the JSON result. Pure ECMAScript — it uses
 * only Proxy/JSON, both of which exist in a bare isolate.
 */
const BOOTSTRAP = `
globalThis.corsair = (function () {
  function make(path) {
    return new Proxy(function () {}, {
      get: function (_t, prop) {
        if (typeof prop !== "string") return undefined;
        return make(path ? path + "." + prop : prop);
      },
      apply: function (_t, _this, args) {
        var argsJson = JSON.stringify(args.length ? args[0] : {});
        return __corsairCall
          .apply(undefined, [path, argsJson], {
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
  return make("");
})();
void 0;
`;

type TenantCorsair = Record<string, unknown>;

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
};

export async function runScriptSandboxed(
  tenant: TenantCorsair,
  code: string,
  gate: DestructiveGate = { confirmed: false, budget: { remaining: 0 } },
): Promise<ScriptResult> {
  const isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB });
  let timer: ReturnType<typeof setTimeout> | undefined;

  // The host side of the bridge: validate the path against the allowlist,
  // resolve the method on the tenant-scoped Corsair client, call it, and hand
  // back a JSON envelope. It ALWAYS resolves (never rejects across the isolate
  // boundary — that would surface as an uncaught host rejection); errors travel
  // as `{ ok: false, error }` and are re-thrown inside the isolate by the proxy.
  const fail = (error: string) => JSON.stringify({ ok: false, error });
  const hostCall = async (pathStr: string, argsJson: string): Promise<string> => {
    try {
      if (!isAllowedPath(pathStr)) return fail(`operation not allowed: ${pathStr}`);
      if (isDestructive(pathStr)) {
        if (!gate.confirmed) {
          return fail(
            `CONFIRM_REQUIRED: "${pathStr}" sends or changes things on the user's account. Do not retry it now. First tell the user exactly what you will do, then ask them to reply "confirm".`,
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
      }
      const parts = pathStr.split(".");
      const method = parts.pop()!;
      let parent: unknown = tenant;
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
        return fail("result too large — filter/slice inside the script and return only what you need");
      }
      return `{"ok":true,"data":${dataJson}}`;
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  };

  try {
    const context = await isolate.createContext();
    await context.global.set("__corsairCall", new ivm.Reference(hostCall));
    await (await isolate.compileScript(BOOTSTRAP)).run(context);

    // Wrap the model's code so its return value is serialized out as JSON. The
    // user code runs as an async body, so `return x` works; undefined → null.
    const wrapped = `(async () => {\n${code}\n})().then((r) => JSON.stringify(r === undefined ? null : r));`;
    const script = await isolate.compileScript(wrapped);

    const runPromise = script.run(context, {
      promise: true,
      timeout: SYNC_TIMEOUT_MS,
    }) as Promise<string>;

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
