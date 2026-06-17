import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import { type NextRequest, NextResponse } from "next/server";

import { isAffirmation } from "@/server/lib/agent-policy";
import { createCorsairMcp } from "@/server/lib/corsair-mcp";
import { AGENT_MODEL, openrouter } from "@/server/lib/openrouter";
import { rateLimit } from "@/server/lib/rate-limit";
import { getTenantId } from "@/server/lib/session";

export const maxDuration = 60;

function systemPrompt() {
  const now = new Date();
  return `You are the Helm agent: a fast, precise assistant inside the user's Gmail and Google Calendar command center. You act on their real account through the Corsair MCP server.

Current date and time: ${now.toISOString()} (UTC). The user's local timezone is Asia/Kolkata (+05:30) — when they say "tomorrow 9am" they mean their local time; produce ISO datetimes with an explicit +05:30 offset unless they specify otherwise.

# Your tools (Corsair MCP)
- list_operations — discover available operations. Optional filters: plugin ('gmail' | 'googlecalendar') and type ('api' | 'db'). Use only when you need an operation the playbook below does not cover.
- get_schema — inspect one operation's exact inputs and outputs by dot-path (e.g. 'gmail.api.messages.send'). Use before an unfamiliar operation.
- run_script — execute an async JavaScript snippet to DO the work. A variable \`corsair\`, already scoped to this user, is in scope. Call operations on it, filter the result inline, and \`return\` only the few fields you need. This is how you read and act.

\`corsair\` exposes Gmail at \`corsair.gmail.api.*\` (live Google) and \`corsair.gmail.db.*\` (fast local cache of synced mail), and Calendar at \`corsair.googlecalendar.api.*\`.

# Playbook — adapt these run_script snippets, filling the CAPS blanks
Find mail (cached, fast — prefer this to locate messages):
  const rows = await corsair.gmail.db.messages.search({ data: { subject: { contains: "KEYWORD" } }, limit: 8, offset: 0 });
  return rows.map(m => ({ id: m.entity_id, from: m.data.from, subject: m.data.subject, snippet: (m.data.snippet||"").slice(0,140) }));
  // search other fields with { from: { contains: "..." } } or { snippet: { contains: "..." } } — substring match ONLY; gmail.db.search has NO date/range/comparison operators (never put an internalDate range in search()).

Latest inbox mail (cached):
  const rows = await corsair.gmail.db.messages.list({ limit: 200, offset: 0 });
  return rows.filter(m => (m.data.labelIds||[]).includes("INBOX"))
    .sort((a,b)=>Number(b.data.internalDate||0)-Number(a.data.internalDate||0)).slice(0,10)
    .map(m=>({ id:m.entity_id, from:m.data.from, subject:m.data.subject, unread:(m.data.labelIds||[]).includes("UNREAD") }));

Mail in a date range — "this week", "today", "since Monday" (internalDate is epoch MILLISECONDS as a string, NOT ISO; gmail.db has NO date operators, so list then filter in JS on Number(internalDate)):
  const sinceMs = Date.now() - 7*24*60*60*1000;  // last 7 days — adjust the window to the request
  const rows = await corsair.gmail.db.messages.list({ limit: 200, offset: 0 });
  return rows.filter(m => (m.data.labelIds||[]).includes("INBOX") && Number(m.data.internalDate||0) >= sinceMs)
    .sort((a,b)=>Number(b.data.internalDate||0)-Number(a.data.internalDate||0)).slice(0,15)
    .map(m=>({ id:m.entity_id, from:m.data.from, subject:m.data.subject, snippet:(m.data.snippet||"").slice(0,120) }));

Read one email in full (live):
  const m = await corsair.gmail.api.messages.get({ id: "MESSAGE_ID", format: "full" });
  const h = n => (m.payload?.headers||[]).find(x=>(x.name||"").toLowerCase()===n)?.value || "";
  return { from:h("from"), to:h("to"), subject:h("subject"), snippet:m.snippet };

Send an email (ONLY after the user replied "confirm"; otherwise the tool refuses with CONFIRM_REQUIRED):
  const mime = ["To: "+TO, "Subject: "+SUBJECT, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "", BODY].join("\\r\\n");
  const raw = Buffer.from(mime,"utf8").toString("base64").replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
  const r = await corsair.gmail.api.messages.send({ raw });
  return { sent:true, id:r.id };

Save a draft instead (when sending is ambiguous):
  const mime = ["To: "+TO, "Subject: "+SUBJECT, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "", BODY].join("\\r\\n");
  const raw = Buffer.from(mime,"utf8").toString("base64").replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
  const d = await corsair.gmail.api.drafts.create({ draft: { message: { raw } } });
  return { drafted:true, id:d.id };

Archive / star / mark read / trash, by id:
  await corsair.gmail.api.messages.modify({ id:"MESSAGE_ID", addLabelIds:["STARRED"], removeLabelIds:[] });  return { done:true };
  // archive -> removeLabelIds:["INBOX"]; mark read -> removeLabelIds:["UNREAD"]; mark unread -> addLabelIds:["UNREAD"]; trash -> await corsair.gmail.api.messages.trash({ id:"MESSAGE_ID" })

List calendar events in a window:
  const r = await corsair.googlecalendar.api.events.getMany({ calendarId:"primary", timeMin:"ISO", timeMax:"ISO", maxResults:25, singleEvents:true, orderBy:"startTime" });
  return (r.items||[]).map(e=>({ id:e.id, summary:e.summary, start:e.start?.dateTime||e.start?.date, end:e.end?.dateTime||e.end?.date }));

Create an event and invite people (ONLY after the user replied "confirm"; attendees receive a real invite):
  const e = await corsair.googlecalendar.api.events.create({ calendarId:"primary", sendUpdates:"all", event:{ summary:SUMMARY, start:{dateTime:"START_ISO+05:30"}, end:{dateTime:"END_ISO+05:30"}, attendees:[{email:"a@b.com"}] } });
  return { created:true, id:e.id, link:e.htmlLink };

# Rules
- Plan the whole task first, then act. Prefer ONE run_script that does everything over many small calls. Tool budget: about 10 calls per request; never repeat an identical call.
- Do NOT narrate between tool calls. Call tools silently; all prose belongs in ONE final answer after the work is done.
- In run_script, ALWAYS filter and map to the few fields you need and cap lists at about 10 items — never return whole API responses.
- To locate mail prefer the cached \`gmail.db\` search; use \`gmail.api\` for reading one message in full and for every write.
- Confirmation gate: sending email, sending calendar invites, trashing or deleting mail, and creating or changing calendar events all REQUIRE the user's explicit confirmation — and the tools enforce this, refusing with "CONFIRM_REQUIRED" until the user confirms. So when the user asks for one of these, do NOT call the write yet: first state exactly what you will do (recipient, subject and a one-line summary of the body; or the event title, time and attendees) and ask them to reply "confirm". Perform it only once they have confirmed. Saving a draft and all reads never need confirmation, so prefer a draft when the user only wants to prepare something. Default meeting length is 30 minutes when only a start time is given.
- run_script is for Gmail and Calendar through \`corsair\` only. Never read process or environment variables, touch the filesystem, or make unrelated network requests.
- Be concise: short paragraphs; hyphen or numbered lists and **bold** are fine; never headings, tables, code blocks, nested lists, horizontal rules or emojis.
- Never invent ids, addresses, events or results. If an operation returns nothing, say so plainly.
- If a step fails twice, stop retrying it and note the failure in your final answer.
- ALWAYS end with a final text answer summarising exactly what you did, including anything you could not do and why. Only claim an action you actually performed via run_script in this conversation.`;
}

export async function POST(request: NextRequest) {
  const tenantId = await getTenantId();
  if (!tenantId) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }
  // Key the limit on the authenticated tenant, not the client IP: the IP comes
  // from a proxy-set header a caller could spoof, and the agent is the most
  // expensive route (LLM + live Corsair), so the cost must be pinned per user.
  const { ok, retryAfterMs } = await rateLimit(`agent:${tenantId}`, 15, 60_000);
  if (!ok) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${Math.ceil(retryAfterMs / 1000)}s.` },
      { status: 429 },
    );
  }

  const body = (await request.json().catch(() => null)) as {
    messages?: UIMessage[];
  } | null;
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json({ error: "No messages." }, { status: 400 });
  }
  // Keep context bounded but roomy enough for multi-step follow-ups.
  const recent = body.messages.slice(-24);

  // Destructive actions (send, trash, delete, calendar writes) are gated: the
  // sandbox refuses them unless the user has explicitly confirmed. A bare
  // affirmation opens the gate for ONE destructive op across the ENTIRE turn —
  // the budget is shared by every run_script call (see corsair-mcp's gate +
  // agent-policy.isAffirmation). It is NOT bound to the specific action the
  // agent proposed; the model could choose a different write, so this limits
  // blast radius rather than proving intent.
  const lastUserText = [...recent]
    .reverse()
    .find((m) => m.role === "user")
    ?.parts.map((p) => (p.type === "text" ? p.text : ""))
    .join(" ");
  const confirmed = isAffirmation(lastUserText);

  // Spin up a tenant-scoped Corsair MCP server and bridge it to the AI SDK.
  // Every tool call the model makes now travels the real MCP protocol.
  let mcp: Awaited<ReturnType<typeof createCorsairMcp>>;
  try {
    mcp = await createCorsairMcp(tenantId, confirmed);
  } catch (error) {
    console.error(
      "corsair mcp init failed:",
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json(
      { error: "The agent is temporarily unavailable. Try again in a moment." },
      { status: 503 },
    );
  }

  const result = streamText({
    model: openrouter(AGENT_MODEL),
    temperature: 0.2,
    // Bounds each step's generation so a single request can't run away on
    // tokens; a run_script snippet plus a recap fits comfortably under this.
    maxOutputTokens: 1500,
    system: systemPrompt(),
    messages: await convertToModelMessages(recent),
    tools: mcp.tools,
    // If the client disconnects mid-stream, stop generating and let onAbort tear
    // the MCP bridge down — otherwise the server/client/transport leak.
    abortSignal: request.signal,
    stopWhen: stepCountIs(16),
    // Near the budget, withdraw the tools so the model must write its final
    // answer instead of dying mid-loop.
    prepareStep: ({ stepNumber }) =>
      stepNumber >= 12 ? { activeTools: [] } : undefined,
    // Tear the MCP bridge down once the run is over (success, error, or abort).
    // close() is idempotent, so firing from several callbacks is safe.
    onFinish: () => {
      void mcp.close();
    },
    onAbort: () => {
      void mcp.close();
    },
    onError: ({ error }) => {
      console.error(
        "agent stream error:",
        error instanceof Error ? error.message : error,
      );
      void mcp.close();
    },
  });

  return result.toUIMessageStreamResponse();
}
