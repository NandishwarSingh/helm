import "server-only";
import { tool } from "ai";
import { z } from "zod";

import { corsair } from "@/server/corsair";
import { encodeRawEmail, extractBodyFromPayload, getHeader } from "@/server/lib/email";

/**
 * The agent's hands: Corsair operations exposed as model tools, scoped to
 * one tenant. Reads favour the local cache; writes go live to Google.
 * Outputs are deliberately compact to keep the context small.
 */
export function buildAgentTools(tenantId: string) {
  const tenant = corsair.withTenant(tenantId);

  const searchMail = tool({
    description:
      "Search the user's mailbox (cached). Returns id, sender, subject, date and snippet for each match. Use before reading or acting on mail.",
    inputSchema: z.object({
      query: z
        .string()
        .max(120)
        .describe("Words from the subject, sender or body snippet"),
      limit: z.number().min(1).max(15).default(8),
    }),
    execute: async ({ query, limit }) => {
      const fields = [
        { snippet: { contains: query } },
        { subject: { contains: query } },
        { from: { contains: query } },
      ];
      const results = await Promise.all(
        fields.map((data) =>
          tenant.gmail.db.messages.search({ data, limit, offset: 0 }),
        ),
      );
      const seen = new Set<string>();
      const items = results
        .flat()
        .filter((m) => {
          if (seen.has(m.entity_id)) return false;
          seen.add(m.entity_id);
          return true;
        })
        .slice(0, limit)
        .map((m) => ({
          id: m.entity_id,
          from: m.data.from ?? "",
          subject: m.data.subject ?? "",
          date: m.data.internalDate
            ? new Date(Number(m.data.internalDate)).toISOString()
            : null,
          snippet: (m.data.snippet ?? "").slice(0, 140),
        }));
      return { count: items.length, items };
    },
  });

  const listRecentMail = tool({
    description:
      "List the most recent messages in the inbox (cached), newest first.",
    inputSchema: z.object({
      limit: z.number().min(1).max(20).default(10),
      unreadOnly: z.boolean().default(false),
    }),
    execute: async ({ limit, unreadOnly }) => {
      const rows = await tenant.gmail.db.messages.list({
        limit: 60,
        offset: 0,
      });
      const seen = new Set<string>();
      const items = rows
        .filter((m) => {
          if (seen.has(m.entity_id)) return false;
          seen.add(m.entity_id);
          const labels = m.data.labelIds ?? [];
          if (!labels.includes("INBOX")) return false;
          if (unreadOnly && !labels.includes("UNREAD")) return false;
          return true;
        })
        .sort(
          (a, b) =>
            Number(b.data.internalDate ?? 0) - Number(a.data.internalDate ?? 0),
        )
        .slice(0, limit)
        .map((m) => ({
          id: m.entity_id,
          from: m.data.from ?? "",
          subject: m.data.subject ?? "",
          unread: (m.data.labelIds ?? []).includes("UNREAD"),
          date: m.data.internalDate
            ? new Date(Number(m.data.internalDate)).toISOString()
            : null,
          snippet: (m.data.snippet ?? "").slice(0, 120),
        }));
      return { count: items.length, items };
    },
  });

  const readEmail = tool({
    description:
      "Read one email's full content by id (live fetch). Use the id from searchMail or listRecentMail.",
    inputSchema: z.object({ id: z.string().min(1).max(64) }),
    execute: async ({ id }) => {
      const message = await tenant.gmail.api.messages.get({
        id,
        format: "full",
      });
      const headers = message.payload?.headers;
      const body =
        extractBodyFromPayload(message.payload) || (message.snippet ?? "");
      return {
        id,
        from: getHeader(headers, "From"),
        to: getHeader(headers, "To"),
        subject: getHeader(headers, "Subject"),
        body: body.slice(0, 4000),
      };
    },
  });

  const sendEmail = tool({
    description:
      "Send an email from the user's account. Only call when the user clearly asked to send.",
    inputSchema: z.object({
      to: z.string().email().max(320),
      subject: z.string().min(1).max(500),
      body: z.string().min(1).max(20_000),
    }),
    execute: async ({ to, subject, body }) => {
      const raw = encodeRawEmail({ to, subject, body });
      const sent = await tenant.gmail.api.messages.send({ raw });
      return { sent: true, id: sent.id ?? "" };
    },
  });

  const createDraft = tool({
    description:
      "Save an email as a draft (does not send). Prefer this when the user wants to review before sending.",
    inputSchema: z.object({
      to: z.string().email().max(320),
      subject: z.string().min(1).max(500),
      body: z.string().min(1).max(20_000),
    }),
    execute: async ({ to, subject, body }) => {
      const raw = encodeRawEmail({ to, subject, body });
      const draft = await tenant.gmail.api.drafts.create({
        draft: { message: { raw } },
      });
      return { drafted: true, id: draft.id ?? "" };
    },
  });

  const modifyMail = tool({
    description:
      "Archive, trash, star, unstar, or mark a message read/unread by id.",
    inputSchema: z.object({
      id: z.string().min(1).max(64),
      action: z.enum(["archive", "trash", "star", "unstar", "read", "unread"]),
    }),
    execute: async ({ id, action }) => {
      if (action === "trash") {
        await tenant.gmail.api.messages.trash({ id });
        return { done: true, action };
      }
      const change: Record<string, { add?: string[]; remove?: string[] }> = {
        archive: { remove: ["INBOX"] },
        star: { add: ["STARRED"] },
        unstar: { remove: ["STARRED"] },
        read: { remove: ["UNREAD"] },
        unread: { add: ["UNREAD"] },
      };
      const { add, remove } = change[action]!;
      await tenant.gmail.api.messages.modify({
        id,
        addLabelIds: add,
        removeLabelIds: remove,
      });
      return { done: true, action };
    },
  });

  const listEvents = tool({
    description:
      "List calendar events between two ISO datetimes (live from Google Calendar).",
    inputSchema: z.object({
      timeMin: z.string().datetime({ offset: true }),
      timeMax: z.string().datetime({ offset: true }),
    }),
    execute: async ({ timeMin, timeMax }) => {
      const result = await tenant.googlecalendar.api.events.getMany({
        calendarId: "primary",
        timeMin,
        timeMax,
        maxResults: 25,
        singleEvents: true,
        orderBy: "startTime",
      });
      const items = (result.items ?? []).map((event) => ({
        id: event.id ?? "",
        summary: event.summary ?? "",
        start: event.start?.dateTime ?? event.start?.date ?? "",
        end: event.end?.dateTime ?? event.end?.date ?? "",
        attendees: (event.attendees ?? [])
          .map((a) => a.email ?? "")
          .filter(Boolean),
      }));
      return { count: items.length, items };
    },
  });

  const createEvent = tool({
    description:
      "Create a calendar event. Attendees receive a real invite when notify is true. Times must be ISO 8601 with timezone offset.",
    inputSchema: z.object({
      summary: z.string().min(1).max(300),
      start: z.string().datetime({ offset: true }),
      end: z.string().datetime({ offset: true }),
      description: z.string().max(2000).optional(),
      attendees: z.array(z.string().email().max(320)).max(20).default([]),
      notify: z.boolean().default(true),
    }),
    execute: async ({ summary, start, end, description, attendees, notify }) => {
      const event = await tenant.googlecalendar.api.events.create({
        calendarId: "primary",
        sendUpdates: notify && attendees.length > 0 ? "all" : "none",
        event: {
          summary,
          description,
          start: { dateTime: start },
          end: { dateTime: end },
          attendees: attendees.map((email) => ({ email })),
        },
      });
      return {
        created: true,
        id: event.id ?? "",
        link: event.htmlLink ?? "",
        invitesSent: notify && attendees.length > 0,
      };
    },
  });

  return {
    searchMail,
    listRecentMail,
    readEmail,
    sendEmail,
    createDraft,
    modifyMail,
    listEvents,
    createEvent,
  };
}
