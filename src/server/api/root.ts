import { accountsRouter } from "@/server/api/routers/accounts";
import { billingRouter } from "@/server/api/routers/billing";
import { calendarRouter } from "@/server/api/routers/calendar";
import { connectionRouter } from "@/server/api/routers/connection";
import { conversationsRouter } from "@/server/api/routers/conversations";
import { documentsRouter } from "@/server/api/routers/documents";
import { gmailRouter } from "@/server/api/routers/gmail";
import { triageRouter } from "@/server/api/routers/triage";
import { createCallerFactory, createTRPCRouter } from "@/server/api/trpc";

/**
 * The primary tRPC router. Each feature router added under
 * /api/routers must be registered here.
 */
export const appRouter = createTRPCRouter({
  gmail: gmailRouter,
  calendar: calendarRouter,
  connection: connectionRouter,
  triage: triageRouter,
  accounts: accountsRouter,
  billing: billingRouter,
  documents: documentsRouter,
  conversations: conversationsRouter,
});

export type AppRouter = typeof appRouter;

/** Server-side caller for invoking the API from RSC / server code. */
export const createCaller = createCallerFactory(appRouter);
