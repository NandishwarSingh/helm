/**
 * YOU PROBABLY DON'T NEED TO EDIT THIS FILE, UNLESS:
 * 1. You want to modify request context (see Part 1).
 * 2. You want to create a new middleware or type of procedure (see Part 3).
 *
 * TL;DR - This is where all the tRPC server stuff is created and plugged in. The pieces you will
 * need to use are documented accordingly near the end.
 */
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";

import { db } from "@/server/db";
import { clientIp, rateLimit } from "@/server/lib/rate-limit";
import { getTenantId } from "@/server/lib/session";

/**
 * 1. CONTEXT
 *
 * This section defines the "contexts" that are available in the backend API.
 *
 * These allow you to access things when processing a request, like the database, the session, etc.
 *
 * This helper generates the "internals" for a tRPC context. The API handler and RSC clients each
 * wrap this and provides the required context.
 *
 * @see https://trpc.io/docs/server/context
 */
export const createTRPCContext = async (opts: { headers: Headers }) => {
  return {
    db,
    ...opts,
  };
};

/**
 * 2. INITIALIZATION
 *
 * This is where the tRPC API is initialized, connecting the context and transformer. We also parse
 * ZodErrors so that you get typesafety on the frontend if your procedure fails due to validation
 * errors on the backend.
 */
const t = initTRPC.context<typeof createTRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

/**
 * Create a server-side caller.
 *
 * @see https://trpc.io/docs/server/server-side-calls
 */
export const createCallerFactory = t.createCallerFactory;

/**
 * 3. ROUTER & PROCEDURE (THE IMPORTANT BIT)
 *
 * These are the pieces you use to build your tRPC API. You should import these a lot in the
 * "/src/server/api/routers" directory.
 */

/**
 * This is how you create new routers and sub-routers in your tRPC API.
 *
 * @see https://trpc.io/docs/router
 */
export const createTRPCRouter = t.router;

/** Logs per-procedure timing during development. */
const timingMiddleware = t.middleware(async ({ next, path }) => {
  const start = Date.now();
  const result = await next();
  if (t._config.isDev) {
    console.log(`[TRPC] ${path} took ${Date.now() - start}ms to execute`);
  }
  return result;
});

/**
 * Per-IP throttling: every call counts against a generous global budget, and
 * mutations against a tighter one, so neither reads nor writes can be hammered.
 */
const rateLimitMiddleware = t.middleware(async ({ ctx, type, next }) => {
  const ip = clientIp(ctx.headers);
  const all = rateLimit(`rpc:${ip}`, 240, 60_000);
  if (!all.ok) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `Too many requests. Try again in ${Math.ceil(all.retryAfterMs / 1000)}s.`,
    });
  }
  if (type === "mutation") {
    const writes = rateLimit(`mutation:${ip}`, 30, 60_000);
    if (!writes.ok) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: `Too many requests. Try again in ${Math.ceil(writes.retryAfterMs / 1000)}s.`,
      });
    }
  }
  return next();
});

/** Rejects calls that arrive without a valid signed session cookie. */
const authMiddleware = t.middleware(async ({ next }) => {
  if (!(await getTenantId())) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Sign in to continue.",
    });
  }
  return next();
});

/**
 * Public procedure — rate limited, no session required. Only for endpoints
 * that must work before sign-in (connection status).
 */
export const publicProcedure = t.procedure
  .use(rateLimitMiddleware)
  .use(timingMiddleware);

/**
 * Authenticated procedure — every Gmail and Calendar endpoint. Requires the
 * signed session cookie on top of the rate limits; tenant scoping happens in
 * the handlers via getTenant().
 */
export const authedProcedure = t.procedure
  .use(rateLimitMiddleware)
  .use(authMiddleware)
  .use(timingMiddleware);
