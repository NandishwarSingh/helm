import { z } from "zod";

import { purgeCachedEntity } from "@/server/lib/cache";
import { listOrEmpty } from "@/server/lib/corsair-errors";
import { getTenantId } from "@/server/lib/session";
import { getTenant } from "@/server/lib/tenant";
import { authedProcedure, createTRPCRouter } from "@/server/api/trpc";

const paginationSchema = z.object({
  limit: z.number().min(1).max(100).default(50),
  offset: z.number().min(0).default(0),
});

function eventStartTimestamp(event: {
  data: {
    start?: { date?: string; dateTime?: string };
  };
}): number {
  const start = event.data.start?.dateTime ?? event.data.start?.date;
  if (!start) return 0;
  return new Date(start).getTime();
}

function mapEvent(event: {
  entity_id: string;
  data: {
    summary?: string;
    description?: string;
    location?: string;
    status?: string;
    start?: { date?: string; dateTime?: string; timeZone?: string };
    end?: { date?: string; dateTime?: string; timeZone?: string };
    attendees?: { email?: string; displayName?: string }[];
    htmlLink?: string;
    createdAt?: Date | null;
  };
}) {
  return {
    id: event.entity_id,
    summary: event.data.summary ?? "",
    description: event.data.description ?? "",
    location: event.data.location ?? "",
    status: event.data.status ?? "",
    start: event.data.start?.dateTime ?? event.data.start?.date ?? "",
    end: event.data.end?.dateTime ?? event.data.end?.date ?? "",
    attendees:
      event.data.attendees
        ?.map((a) => {
          if (a.displayName && a.email) return `${a.displayName} <${a.email}>`;
          return a.email ?? a.displayName ?? "";
        })
        .filter(Boolean) ?? [],
    htmlLink: event.data.htmlLink ?? "",
    createdAt: event.data.createdAt ?? null,
    timestamp: eventStartTimestamp(event),
  };
}

function dedupeByEntityId<
  T extends { entity_id: string; updated_at: Date },
>(items: T[]): T[] {
  const byEntityId = new Map<string, T>();
  for (const item of items) {
    const existing = byEntityId.get(item.entity_id);
    if (!existing || item.updated_at > existing.updated_at) {
      byEntityId.set(item.entity_id, item);
    }
  }
  return Array.from(byEntityId.values());
}

function filterEventsByWeek<
  T extends { timestamp: number; start: string },
>(events: T[], weekStart: Date, weekEnd: Date): T[] {
  const startMs = weekStart.getTime();
  const endMs = weekEnd.getTime();

  return events
    .filter((event) => {
      if (event.timestamp > 0) {
        return event.timestamp >= startMs && event.timestamp < endMs;
      }
      if (!event.start) return false;
      const ts = new Date(event.start).getTime();
      return ts >= startMs && ts < endMs;
    })
    .sort((a, b) => a.timestamp - b.timestamp);
}

export const calendarRouter = createTRPCRouter({
  searchEvents: authedProcedure
    .input(
      paginationSchema.extend({
        query: z.string().max(256),
        weekStart: z.string().datetime(),
        weekEnd: z.string().datetime(),
      }),
    )
    .query(async ({ input }) => {
      const weekStart = new Date(input.weekStart);
      const weekEnd = new Date(input.weekEnd);

      const events = await listOrEmpty(async () => {
        const tenant = await getTenant();
        return input.query.trim()
          ? tenant.googlecalendar.db.events.search({
              data: {
                summary: { contains: input.query },
              },
              limit: 200,
              offset: 0,
            })
          : tenant.googlecalendar.db.events.list({
              limit: 200,
              offset: 0,
            });
      });

      return filterEventsByWeek(
        dedupeByEntityId(events).map(mapEvent),
        weekStart,
        weekEnd,
      );
    }),

  refreshEvents: authedProcedure
    .input(
      z.object({
        weekStart: z.string().datetime(),
        weekEnd: z.string().datetime(),
      }),
    )
    .mutation(async ({ input }) => {
      const tenant = await getTenant();
      const result = await tenant.googlecalendar.api.events.getMany({
        calendarId: "primary",
        timeMin: input.weekStart,
        timeMax: input.weekEnd,
        maxResults: 100,
        singleEvents: true,
        orderBy: "startTime",
      });
      return {
        synced: result.items?.length ?? 0,
      };
    }),

  createDraft: authedProcedure
    .input(
      z.object({
        summary: z.string().min(1).max(300),
        description: z.string().max(5000).optional(),
        location: z.string().max(500).optional(),
        start: z.string().datetime(),
        end: z.string().datetime(),
        attendees: z.array(z.string().email().max(320)).max(50).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const tenant = await getTenant();
      const event = await tenant.googlecalendar.api.events.create({
        calendarId: "primary",
        sendUpdates: "none",
        event: {
          summary: input.summary,
          description: input.description,
          location: input.location,
          status: "tentative",
          start: { dateTime: input.start },
          end: { dateTime: input.end },
          attendees: input.attendees?.map((email) => ({ email })),
        },
      });
      return {
        id: event.id ?? "",
        htmlLink: event.htmlLink ?? "",
      };
    }),

  updateEvent: authedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        summary: z.string().min(1).max(300),
        description: z.string().max(5000).optional(),
        location: z.string().max(500).optional(),
        start: z.string().datetime(),
        end: z.string().datetime(),
        attendees: z.array(z.string().email().max(320)).max(50),
        // Notify attendees about the change when any are present.
        notify: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      const tenant = await getTenant();
      const event = await tenant.googlecalendar.api.events.update({
        calendarId: "primary",
        id: input.id,
        sendUpdates: input.notify ? "all" : "none",
        event: {
          summary: input.summary,
          description: input.description,
          location: input.location,
          start: { dateTime: input.start },
          end: { dateTime: input.end },
          attendees: input.attendees.map((email) => ({ email })),
        },
      });
      return { id: event.id ?? input.id, htmlLink: event.htmlLink ?? "" };
    }),

  deleteEvent: authedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        notify: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      const tenant = await getTenant();
      await tenant.googlecalendar.api.events.delete({
        calendarId: "primary",
        id: input.id,
        sendUpdates: input.notify ? "all" : "none",
      });
      const tenantId = await getTenantId();
      if (tenantId) await purgeCachedEntity(tenantId, input.id);
      return { ok: true };
    }),

  sendInvite: authedProcedure
    .input(
      z.object({
        summary: z.string().min(1).max(300),
        description: z.string().max(5000).optional(),
        location: z.string().max(500).optional(),
        start: z.string().datetime(),
        end: z.string().datetime(),
        attendees: z.array(z.string().email().max(320)).min(1).max(50),
      }),
    )
    .mutation(async ({ input }) => {
      const tenant = await getTenant();
      const event = await tenant.googlecalendar.api.events.create({
        calendarId: "primary",
        sendUpdates: "all",
        event: {
          summary: input.summary,
          description: input.description,
          location: input.location,
          start: { dateTime: input.start },
          end: { dateTime: input.end },
          attendees: input.attendees.map((email) => ({ email })),
        },
      });
      return {
        id: event.id ?? "",
        htmlLink: event.htmlLink ?? "",
      };
    }),
});
