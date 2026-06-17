import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/server/db";
import { gmailWatch, userAccounts } from "@/server/db/schema";
import { getSession, setActiveAccountCookie } from "@/server/lib/session";
import { getActiveAccount, getUserAccounts } from "@/server/lib/users";
import { authedProcedure, createTRPCRouter } from "@/server/api/trpc";

/**
 * Multi-account management: list the session's accounts, switch the active one,
 * set a primary, or unlink. Every mutation re-validates that the target account
 * belongs to the caller — the client only ever supplies account ids.
 */
export const accountsRouter = createTRPCRouter({
  list: authedProcedure.query(async () => {
    const accounts = await getUserAccounts();
    const active = await getActiveAccount();
    return {
      accounts: accounts.map((a) => ({
        id: a.id,
        email: a.email,
        label: a.label,
        color: a.color,
        isPrimary: a.isPrimary,
      })),
      activeId: active?.id ?? null,
      // Multiple mailboxes unlock the unified view + switcher.
      multi: accounts.length > 1,
    };
  }),

  setActive: authedProcedure
    .input(z.object({ accountId: z.string().max(64) }))
    .mutation(async ({ input }) => {
      const accounts = await getUserAccounts();
      if (!accounts.some((a) => a.id === input.accountId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "unknown account" });
      }
      await setActiveAccountCookie(input.accountId);
      return { ok: true };
    }),

  setPrimary: authedProcedure
    .input(z.object({ accountId: z.string().max(64) }))
    .mutation(async ({ input }) => {
      const session = await getSession();
      if (session?.kind !== "user") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "single account" });
      }
      const accounts = await getUserAccounts();
      if (!accounts.some((a) => a.id === input.accountId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "unknown account" });
      }
      await db
        .update(userAccounts)
        .set({ isPrimary: false })
        .where(eq(userAccounts.userId, session.id));
      await db
        .update(userAccounts)
        .set({ isPrimary: true })
        .where(
          and(
            eq(userAccounts.userId, session.id),
            eq(userAccounts.id, input.accountId),
          ),
        );
      return { ok: true };
    }),

  remove: authedProcedure
    .input(z.object({ accountId: z.string().max(64) }))
    .mutation(async ({ input }) => {
      const session = await getSession();
      if (session?.kind !== "user") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "single account" });
      }
      const accounts = await getUserAccounts();
      const target = accounts.find((a) => a.id === input.accountId);
      if (!target) {
        throw new TRPCError({ code: "FORBIDDEN", message: "unknown account" });
      }
      if (accounts.length <= 1) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "cannot remove the last account",
        });
      }
      await db
        .delete(userAccounts)
        .where(
          and(
            eq(userAccounts.userId, session.id),
            eq(userAccounts.id, input.accountId),
          ),
        );
      // Stop routing pushes to a mailbox we no longer show.
      await db.delete(gmailWatch).where(eq(gmailWatch.tenantId, target.tenantId));
      // If the primary was removed, promote whatever remains.
      if (target.isPrimary) {
        const [next] = await db
          .select({ id: userAccounts.id })
          .from(userAccounts)
          .where(eq(userAccounts.userId, session.id))
          .limit(1);
        if (next) {
          await db
            .update(userAccounts)
            .set({ isPrimary: true })
            .where(eq(userAccounts.id, next.id));
        }
      }
      return { ok: true };
    }),
});
