import type { NextRequest } from "next/server";

import { subscribeTenant } from "@/server/lib/realtime";
import { getTenantId } from "@/server/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-Sent Events stream. The client opens one EventSource; whenever a
 * Corsair webhook reports a change for this tenant, a `changed` event is pushed
 * and the UI refetches — realtime updates without polling. A periodic comment
 * keeps the connection alive through nginx.
 */
export async function GET(request: NextRequest) {
  const tenantId = await getTenantId();
  if (!tenantId) return new Response("unauthorized", { status: 401 });

  const encoder = new TextEncoder();
  let unsubscribe = () => undefined as void;
  let keepAlive: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const write = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          /* connection already closed */
        }
      };
      write("event: ready\ndata: ok\n\n");
      unsubscribe = subscribeTenant(tenantId, (kind) => {
        write(`event: changed\ndata: ${kind}\n\n`);
      });
      keepAlive = setInterval(() => write(": ping\n\n"), 25_000);
      request.signal.addEventListener("abort", () => {
        unsubscribe();
        if (keepAlive) clearInterval(keepAlive);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      unsubscribe();
      if (keepAlive) clearInterval(keepAlive);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable nginx proxy buffering so events flush immediately.
      "X-Accel-Buffering": "no",
    },
  });
}
