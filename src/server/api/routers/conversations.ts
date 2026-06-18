import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/server/db";
import { conversations } from "@/server/db/schema";
import { getOwnerId } from "@/server/lib/session";
import { authedProcedure, createTRPCRouter } from "@/server/api/trpc";

// Persisted agent chat history. Every row is scoped to the session OWNER
// (getOwnerId), and every query/mutation filters by it — a client only ever
// supplies a conversation id, never another owner's, so cross-owner access is
// structurally impossible. Messages are the client's UIMessage[] stored as-is;
// we don't trust their shape for anything but display, so they're opaque here.
const MAX_TITLE = 200;
const MAX_MESSAGES = 200;

async function requireOwner(): Promise<string> {
  const owner = await getOwnerId();
  // authedProcedure already guaranteed a session; this is belt-and-braces.
  if (!owner) throw new TRPCError({ code: "UNAUTHORIZED" });
  return owner;
}

export const conversationsRouter = createTRPCRouter({
  // History list for the owner — metadata only (no message bodies), newest first.
  list: authedProcedure.query(async () => {
    const owner = await requireOwner();
    const rows = await db
      .select({
        id: conversations.id,
        title: conversations.title,
        updatedAt: conversations.updatedAt,
      })
      .from(conversations)
      .where(eq(conversations.ownerId, owner))
      .orderBy(desc(conversations.updatedAt))
      .limit(50);
    return { items: rows };
  }),

  // Full thread for one conversation — ownership-scoped, so an unknown/foreign id
  // simply returns null.
  get: authedProcedure
    .input(z.object({ id: z.string().min(1).max(64) }))
    .query(async ({ input }) => {
      const owner = await requireOwner();
      const [row] = await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.ownerId, owner),
            eq(conversations.id, input.id),
          ),
        )
        .limit(1);
      if (!row) return null;
      return { id: row.id, title: row.title, messages: row.messages };
    }),

  // Upsert the current thread. Called when a turn settles; the id is the client's
  // conversation id and the row is always written under the caller's ownerId.
  save: authedProcedure
    .input(
      z.object({
        id: z.string().min(1).max(64),
        title: z.string().max(MAX_TITLE).default(""),
        // UIMessage[] — opaque to the server (display-only on the client).
        messages: z.array(z.unknown()).max(MAX_MESSAGES),
      }),
    )
    .mutation(async ({ input }) => {
      const owner = await requireOwner();
      const now = new Date();
      await db
        .insert(conversations)
        .values({
          id: input.id,
          ownerId: owner,
          title: input.title.slice(0, MAX_TITLE),
          messages: input.messages,
          createdAt: now,
          updatedAt: now,
        })
        // Re-assert ownerId in the WHERE so a colliding id from another owner can
        // never be overwritten (the PK is global, but the update is owner-scoped).
        .onConflictDoUpdate({
          target: conversations.id,
          set: {
            title: input.title.slice(0, MAX_TITLE),
            messages: input.messages,
            updatedAt: now,
          },
          setWhere: eq(conversations.ownerId, owner),
        });
      return { ok: true };
    }),

  rename: authedProcedure
    .input(z.object({ id: z.string().min(1).max(64), title: z.string().max(MAX_TITLE) }))
    .mutation(async ({ input }) => {
      const owner = await requireOwner();
      await db
        .update(conversations)
        .set({ title: input.title.slice(0, MAX_TITLE) })
        .where(
          and(eq(conversations.ownerId, owner), eq(conversations.id, input.id)),
        );
      return { ok: true };
    }),

  remove: authedProcedure
    .input(z.object({ id: z.string().min(1).max(64) }))
    .mutation(async ({ input }) => {
      const owner = await requireOwner();
      await db
        .delete(conversations)
        .where(
          and(eq(conversations.ownerId, owner), eq(conversations.id, input.id)),
        );
      return { ok: true };
    }),
});
