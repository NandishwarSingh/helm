import "server-only";
import { EventEmitter } from "node:events";

/**
 * Process-local realtime fan-out. When Corsair pushes a Gmail/Calendar change
 * to /api/webhooks, the handler notifies the affected tenant; every open SSE
 * connection for that tenant gets it instantly, so the UI updates with no
 * polling. Single-instance is enough for the current deploy; to run several
 * instances, bridge `notifyTenant` through Redis pub/sub (the ioredis client is
 * already a dependency).
 */
const globalForBus = globalThis as unknown as { mailBus?: EventEmitter };
const bus = globalForBus.mailBus ?? new EventEmitter();
bus.setMaxListeners(0); // many concurrent SSE clients
globalForBus.mailBus = bus;

export function notifyTenant(tenantId: string, kind = "mail"): void {
  // Dev-only: this fires on every push and would spew tenant ids into prod logs.
  if (process.env.NODE_ENV !== "production") {
    console.log(
      "[realtime] notify",
      tenantId,
      "listeners:",
      bus.listenerCount(tenantId),
    );
  }
  bus.emit(tenantId, kind);
}

/** Subscribe a tenant's connection; returns an unsubscribe fn. */
export function subscribeTenant(
  tenantId: string,
  handler: (kind: string) => void,
): () => void {
  bus.on(tenantId, handler);
  return () => bus.off(tenantId, handler);
}
