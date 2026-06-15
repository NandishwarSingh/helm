import { calendarRouter } from "@/server/api/routers/calendar";
import { gmailRouter } from "@/server/api/routers/gmail";
import { createCallerFactory, createTRPCRouter } from "@/server/api/trpc";

/**
 * The primary tRPC router. Each feature router added under
 * /api/routers must be registered here.
 */
export const appRouter = createTRPCRouter({
  gmail: gmailRouter,
  calendar: calendarRouter,
});

export type AppRouter = typeof appRouter;

/** Server-side caller for invoking the API from RSC / server code. */
export const createCaller = createCallerFactory(appRouter);
