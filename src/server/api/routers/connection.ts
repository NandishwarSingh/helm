import { getConnectionStatus } from "@/server/lib/connection";
import { createTRPCRouter, publicProcedure } from "@/server/api/trpc";

export const connectionRouter = createTRPCRouter({
  status: publicProcedure.query(() => getConnectionStatus()),
});
