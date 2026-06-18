import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import { type NextRequest, NextResponse } from "next/server";

import { env } from "@/env";
import { corsair } from "@/server/corsair";
import {
  type ActionSummary,
  signAction,
  summarizeAction,
  verifyAction,
} from "@/server/lib/agent-action";
import { isAllowedPath, isDestructive } from "@/server/lib/agent-policy";
import { createCorsairMcp } from "@/server/lib/corsair-mcp";
import { AGENT_MODEL, openrouter } from "@/server/lib/openrouter";
import { rateLimit } from "@/server/lib/rate-limit";
import { getTenantId } from "@/server/lib/session";
import { getAccountClients } from "@/server/lib/tenant";

export const maxDuration = 60;

/** Resolve a Corsair dot-path on the tenant client and call it with `args`. */
async function callTenantOp(
  tenant: unknown,
  op: string,
  args: unknown,
): Promise<unknown> {
  const parts = op.split(".");
  const method = parts.pop()!;
  let parent: unknown = tenant;
  for (const key of parts) {
    parent = (parent as Record<string, unknown> | undefined)?.[key];
    if (parent == null) throw new Error(`unknown operation: ${op}`);
  }
  const fn = (parent as Record<string, unknown> | undefined)?.[method];
  if (typeof fn !== "function") throw new Error(`not callable: ${op}`);
  return (fn as (a: unknown) => unknown).call(parent, args ?? {});
}

/** A short, kind-specific line shown after a confirmed action runs. */
function confirmedOutcome(summary: ActionSummary): string {
  switch (summary.kind) {
    case "send":
      return "Sent.";
    case "trash":
      return "Moved to Trash.";
    case "delete":
      return "Deleted.";
    case "event-create":
      return "Event created.";
    case "event-update":
      return "Event updated.";
    case "event-delete":
      return "Event deleted.";
    default:
      return "Done.";
  }
}

/** A one-shot assistant message carrying a single block of text (no model call). */
function textResponse(text: string): Response {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ type: "text-start", id: "t0" });
      writer.write({ type: "text-delta", id: "t0", delta: text });
      writer.write({ type: "text-end", id: "t0" });
    },
  });
  return createUIMessageStreamResponse({ stream });
}

// Consumed confirm tokens (process-local): a confirmation executes EXACTLY once,
// so a replayed token can't fire the same send/delete twice. Tokens already
// expire in 10 minutes, so entries are pruned past that; a restart only reopens
// that brief window. Single-instance deploy (mirrors realtime.ts's bus).
const CONFIRM_TTL_MS = 10 * 60 * 1000;
const consumedConfirms = new Map<string, number>();
function consumeConfirmOnce(token: string, nowMs: number): boolean {
  for (const [sig, exp] of consumedConfirms) {
    if (exp <= nowMs) consumedConfirms.delete(sig);
  }
  const sig = token.slice(token.lastIndexOf(".") + 1);
  if (consumedConfirms.has(sig)) return false;
  consumedConfirms.set(sig, nowMs + CONFIRM_TTL_MS);
  return true;
}

function systemPrompt(accounts: string[]) {
  const now = new Date();
  const multiAccount =
    accounts.length > 1
      ? `
# Your connected accounts
This user has ${accounts.length} mailboxes connected: ${accounts.join(", ")}.
By default \`corsair.gmail.*\` and \`corsair.googlecalendar.*\` act on the ACTIVE account (${accounts[0]}). To read or act on a SPECIFIC mailbox, scope the SAME operations onto it: \`corsair.account("${accounts[1] ?? accounts[0]}").gmail.db.messages.list({ limit: 20, offset: 0 })\`. \`corsair.accounts\` returns the list of connected emails. When the user says "all my accounts" / "every inbox", loop \`corsair.accounts\` and use \`corsair.account(email)\` for each (tag each result with its email); when they name or imply one mailbox, target just that one. A staged write runs on whichever account you called it on — so call it on the right one.
`
      : "";
  return `You are the Helm agent: a fast, precise assistant inside the user's Gmail and Google Calendar command center. You act on their real account(s) through the Corsair MCP server.

Current date and time: ${now.toISOString()} (UTC). The user's local timezone is Asia/Kolkata (+05:30) — when they say "tomorrow 9am" they mean their local time; produce ISO datetimes with an explicit +05:30 offset unless they specify otherwise.
${multiAccount}
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

Send an email — CALL this to STAGE it for the user's confirmation card (it returns CONFIRM_REQUIRED, which is expected; do NOT retry):
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

Create an event and invite people — CALL this to STAGE it for confirmation (returns CONFIRM_REQUIRED, expected; attendees receive a real invite once the user confirms):
  const e = await corsair.googlecalendar.api.events.create({ calendarId:"primary", sendUpdates:"all", event:{ summary:SUMMARY, start:{dateTime:"START_ISO+05:30"}, end:{dateTime:"END_ISO+05:30"}, attendees:[{email:"a@b.com"}] } });
  return { created:true, id:e.id, link:e.htmlLink };

# Rules
- Plan the whole task first, then act. Prefer ONE run_script that does everything over many small calls — batch reads/writes and use Promise.all to fan out across accounts or messages in a single script. Tool budget: about 6 calls per request; never repeat an identical call.
- Do NOT narrate between tool calls. Call tools silently; all prose belongs in ONE final answer after the work is done.
- In run_script, ALWAYS filter and map to the few fields you need and cap lists at about 10 items — never return whole API responses.
- To locate mail prefer the cached \`gmail.db\` search; use \`gmail.api\` for reading one message in full and for every write.
- Confirmation: sending mail, sending invites, trashing or deleting mail, and creating, updating or deleting calendar events are STAGED for the user's approval, not run immediately. To do one, CALL the operation in run_script with the exact final details (recipient, subject and the full body; or the event title, time and attendees). The sandbox stages it and returns CONFIRM_REQUIRED, and the user gets a confirmation card with Confirm and Deny — that return is EXPECTED and means it staged successfully, so NEVER retry it or call it again. After staging, write ONE short sentence naming exactly what you staged (e.g. "Staged a reply to Priya about the Q3 review — confirm to send."). Saving a draft and all reads are never staged, so prefer a draft when the user only wants to prepare something. Stage at most ONE action per reply; if more are needed, stage one and say what remains. Default meeting length is 30 minutes when only a start time is given.
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
    confirm?: string;
  } | null;
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json({ error: "No messages." }, { status: 400 });
  }

  // Confirm turn: the user approved an action card. Replay the EXACT signed op
  // they saw — the model is NOT in this loop, so a "yes" can only run the action
  // the card showed, never a different write the model might pick. The token is
  // HMAC-signed, tenant-bound, and expires (see agent-action).
  if (typeof body.confirm === "string") {
    const now = Date.now();
    const action = verifyAction(env.AUTH_SECRET, body.confirm, now);
    if (action?.tenantId !== tenantId) {
      return textResponse(
        "That confirmation expired or didn't match — ask me again and I'll re-stage it.",
      );
    }
    // One-time: a confirmation runs exactly once, so a replayed token (double
    // submit, refresh) can't fire the same action twice.
    if (!consumeConfirmOnce(body.confirm, now)) {
      return textResponse(
        "That action was already confirmed — nothing else to do.",
      );
    }
    // Defense in depth: only ever replay an allowlisted, destructive op.
    if (!isAllowedPath(action.op) || !isDestructive(action.op)) {
      return textResponse("That action can't be run.");
    }
    // Replay on the account the card named (ownership-checked against the user's
    // own connected accounts), else the active one.
    let targetTenantId = tenantId;
    if (action.targetAccount) {
      const owned = (await getAccountClients()).find(
        (a) => a.email === action.targetAccount,
      );
      if (!owned) {
        return textResponse("That account is no longer connected.");
      }
      targetTenantId = owned.tenantId;
    }
    const summary = summarizeAction(action.op, action.args);
    try {
      await callTenantOp(
        corsair.withTenant(targetTenantId),
        action.op,
        action.args,
      );
      return textResponse(confirmedOutcome(summary));
    } catch (error) {
      return textResponse(
        `That didn't go through: ${error instanceof Error ? error.message : "unknown error"}.`,
      );
    }
  }

  // Keep context bounded but roomy enough for multi-step follow-ups. Strip the
  // `data-pendingAction` cards from history so stale signed tokens never reach
  // the model — they're confirmed out-of-band via body.confirm, not by the LLM.
  const recent = body.messages
    .slice(-24)
    .map((m) => ({
      ...m,
      parts: m.parts.filter((p) => !p.type.startsWith("data-")),
    }))
    .filter((m) => m.parts.length > 0);

  // The user's connected accounts — the agent can read/act across all of them
  // via corsair.account("email"), and they're listed in the prompt.
  const accounts = await getAccountClients();

  // Spin up a tenant-scoped Corsair MCP server and bridge it to the AI SDK.
  // Every tool call the model makes now travels the real MCP protocol.
  let mcp: Awaited<ReturnType<typeof createCorsairMcp>>;
  try {
    mcp = await createCorsairMcp(tenantId, accounts);
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
    system: systemPrompt(accounts.map((a) => a.email)),
    messages: await convertToModelMessages(recent),
    tools: mcp.tools,
    // If the client disconnects mid-stream, stop generating and let onAbort tear
    // the MCP bridge down — otherwise the server/client/transport leak.
    abortSignal: request.signal,
    // The playbook pushes "one run_script that does everything", so real tasks
    // finish in a few steps; a tighter ceiling caps the worst case (every step
    // is a full, uncached round-trip) without clipping legitimate work.
    stopWhen: stepCountIs(10),
    // Near the budget, withdraw the tools so the model must write its final
    // answer instead of dying mid-loop.
    prepareStep: ({ stepNumber }) =>
      stepNumber >= 8 ? { activeTools: [] } : undefined,
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

  // Stream the model's reply, then — if it staged a destructive op — append a
  // signed confirmation card the user can Confirm or Deny. The action is captured
  // in `mcp.gate.proposed` by the sandbox and is NEVER executed in this loop;
  // only a Confirm turn replays it (above).
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.merge(result.toUIMessageStream());
      await result.finishReason; // wait for the model to finish staging
      const proposed = mcp.gate.proposed;
      if (proposed && isAllowedPath(proposed.op) && isDestructive(proposed.op)) {
        // Bind the action to the account it was STAGED on. A script that named a
        // mailbox via corsair.account("email") sets proposed.targetAccount; one
        // that didn't ran on the active account — capture THAT here (resolve the
        // active tenant to its email), so the confirm replays on the same mailbox
        // even if the user switches accounts between seeing the card and clicking
        // Confirm. Single-account sessions leave it unset (the tenant can't
        // change, and it keeps the card uncluttered).
        const boundAccount =
          proposed.targetAccount ??
          (accounts.length > 1
            ? accounts.find((a) => a.tenantId === tenantId)?.email
            : undefined);
        const token = signAction(
          env.AUTH_SECRET,
          {
            tenantId,
            op: proposed.op,
            args: proposed.args,
            targetAccount: boundAccount,
          },
          Date.now(),
        );
        const summary = summarizeAction(proposed.op, proposed.args);
        // Show which mailbox the action runs on, so the card stays faithful.
        if (boundAccount) {
          summary.fields.unshift({ label: "Account", value: boundAccount });
        }
        writer.write({
          type: "data-pendingAction",
          id: `pa-${token.slice(-12)}`,
          data: { token, summary },
        });
      }
    },
    onError: (error) => (error instanceof Error ? error.message : String(error)),
  });
  return createUIMessageStreamResponse({ stream });
}
