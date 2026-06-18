"use client";

import { useEffect, useRef, useState } from "react";
import { Chat, useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { motion } from "motion/react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  AgentIcon,
  CloseIcon,
  DocumentsIcon,
  HistoryIcon,
  PaperclipIcon,
  PlusIcon,
  SendIcon,
  TrashIcon,
} from "@/components/icons";
import { Kbd } from "@/components/kbd";
import { Skeleton } from "@/components/skeleton";
import { dispatchOpenRecord, useAction } from "@/lib/actions";
import { formatAccountEmail } from "@/lib/display";
import { listRow } from "@/lib/motion";
import type { ActionSummary } from "@/server/lib/agent-action";
import type { HelmSource } from "@/server/lib/agent-sources";
import type { Suggestion } from "@/server/lib/agent-suggest";
import { api } from "@/trpc/react";

/** What the agent stages for confirmation, carried on a `data-pendingAction` part. */
type PendingAction = { token: string; summary: ActionSummary };
type CardState = "confirmed" | "denied" | undefined;

/** A file the user has attached to the next turn (uploaded or picked from mail). */
type PendingAttachment = {
  key: string;
  name: string;
  mimeType: string;
  text: string;
  status: "loading" | "ready" | "error";
  error?: string;
};
/** Attachment metadata kept on the user message so chips persist in history. */
type AttachmentMeta = { attachments?: { name: string; mimeType: string }[] };

/**
 * The confirmation card for a staged destructive action. Its contents are
 * derived server-side from the EXACT op + args that will run, and Confirm sends
 * the signed token back — so what's shown is exactly what executes.
 */
function ActionCard({
  summary,
  state,
  busy,
  onConfirm,
  onDeny,
}: {
  summary: ActionSummary;
  state: CardState;
  busy: boolean;
  onConfirm: () => void;
  onDeny: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  // Pull focus to Confirm when the card appears so Enter confirms and Esc denies
  // without reaching for the mouse — it's a deliberate, attention-drawing pause.
  useEffect(() => {
    if (!state) confirmRef.current?.focus();
  }, [state]);

  return (
    <div
      className="agent-action"
      data-state={state ?? "pending"}
      onKeyDown={(e) => {
        if (!state && e.key === "Escape") {
          e.preventDefault();
          onDeny();
        }
      }}
    >
      <p className="agent-action-title">{summary.title}</p>
      <dl className="agent-action-fields">
        {summary.fields.map((f, i) => (
          <div key={i}>
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
      {summary.body && <p className="agent-action-body">{summary.body}</p>}
      {state === "confirmed" ? (
        <p className="agent-action-resolved" data-kind="confirmed">
          Confirmed
        </p>
      ) : state === "denied" ? (
        <p className="agent-action-resolved" data-kind="denied">
          Cancelled
        </p>
      ) : (
        <div className="agent-action-buttons">
          <button
            ref={confirmRef}
            type="button"
            className="btn btn-primary"
            onClick={onConfirm}
            disabled={busy}
          >
            Confirm <Kbd>↵</Kbd>
          </button>
          <button type="button" className="btn" onClick={onDeny} disabled={busy}>
            Deny <Kbd>Esc</Kbd>
          </button>
        </div>
      )}
    </div>
  );
}

const SUGGESTIONS = [
  "Summarize my unread mail",
  "What is on my calendar this week?",
  "Find the last email from Google and archive it",
  "Schedule a 30 minute sync with nandishwarjasrotia@gmail.com tomorrow at 9am and email him that I look forward to it",
];

/**
 * Rich, readable rendering for assistant replies: GitHub-flavoured markdown
 * (headings, ordered/unordered lists, tables, links, emphasis, blockquotes,
 * rules) rendered to REACT NODES — never via innerHTML, and raw HTML stays
 * disabled — so the panel keeps its no-injection guarantee. Fenced code blocks
 * are still swallowed so the agent's run_script source can never surface.
 */
const AGENT_MD_COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a href={href ?? undefined} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  // Swallow fenced code blocks; inline `code` (ids, header names) still renders.
  pre: () => null,
};

function AgentText({ text }: { text: string }) {
  return (
    <div className="agent-text agent-md">
      <Markdown remarkPlugins={[remarkGfm]} components={AGENT_MD_COMPONENTS}>
        {text}
      </Markdown>
    </div>
  );
}

/**
 * Friendly labels for tool activity chips. The agent runs on the Corsair MCP
 * server, whose tools are `list_operations`, `get_schema` and `run_script` —
 * run_script carries the real action as a code snippet, so we read its code to
 * name the work instead of surfacing the raw tool name.
 */
function toolLabel(
  type: string,
  state: string,
  input: unknown,
  output: unknown,
): string {
  const name = type.replace(/^tool-/, "");
  const done = state === "output-available";

  if (name === "list_operations") return done ? "Found tools" : "Finding tools";
  if (name === "get_schema") return done ? "Checked the API" : "Checking the API";

  if (name === "run_script") {
    const code =
      typeof (input as { code?: unknown } | null)?.code === "string"
        ? (input as { code: string }).code
        : "";
    // Order matters: drafts.create also builds a MIME body, so check it first.
    if (code.includes("drafts.create")) return done ? "Draft saved" : "Saving draft";
    if (code.includes("messages.send")) return done ? "Email sent" : "Sending email";
    if (code.includes("events.create")) return done ? "Event created" : "Creating event";
    if (/events\.(getMany|list)/.test(code))
      return done ? "Checked calendar" : "Checking calendar";
    if (/messages\.(trash|modify|batchModify)/.test(code))
      return done ? "Mail updated" : "Updating mail";
    if (/messages\.get\b/.test(code)) return done ? "Read email" : "Reading email";
    if (/db\.messages\.(search|list)/.test(code))
      return done ? "Searched mail" : "Searching mail";
    return done ? "Done" : "Working";
  }

  void output;
  return done ? name : `${name}…`;
}

/** Byte-stream URL for a cited email's attachment (preview/download). */
function mediaUrl(accountId: string, messageId: string, attachmentId: string): string {
  const qs = new URLSearchParams({ account: accountId, disposition: "inline" });
  return `/api/documents/${encodeURIComponent(messageId)}/${encodeURIComponent(
    attachmentId,
  )}?${qs.toString()}`;
}

/**
 * End-of-answer citations: the real emails/events the reply drew on. Each is a
 * button that navigates to and opens the record; indexed attachments (images /
 * docs) render inline beneath it — images as thumbnails, docs as openable chips.
 */
function Sources({ sources }: { sources: HelmSource[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="agent-sources">
      <p className="agent-sources-label">Sources</p>
      <ol>
        {sources.map((s) => (
          <li key={`${s.accountId}:${s.id}`}>
            <button
              type="button"
              className="agent-source"
              onClick={() =>
                dispatchOpenRecord({
                  kind: s.kind,
                  accountId: s.accountId,
                  id: s.id,
                  date: s.date,
                })
              }
              title={`Open ${s.kind === "event" ? "event" : "email"}`}
            >
              <span className="agent-source-title">{s.title}</span>
              <span className="agent-source-meta tnum">
                {[
                  s.kind === "email" ? s.from : undefined,
                  s.date,
                  s.account ? formatAccountEmail(s.account) : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </button>
            {s.media?.length ? (
              <div className="agent-source-media">
                {s.media.map((m) => {
                  const url = mediaUrl(s.accountId, s.id, m.attachmentId);
                  const isImage =
                    m.category === "image" || m.mimeType.startsWith("image/");
                  return isImage ? (
                    <a
                      key={m.attachmentId}
                      className="agent-source-thumb"
                      href={url}
                      target="_blank"
                      rel="noreferrer noopener"
                      title={m.filename}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={url} alt={m.filename} loading="lazy" />
                    </a>
                  ) : (
                    <a
                      key={m.attachmentId}
                      className="agent-source-doc"
                      href={url}
                      target="_blank"
                      rel="noreferrer noopener"
                      title={m.filename}
                    >
                      <DocumentsIcon size={13} />
                      <span>{m.filename}</span>
                    </a>
                  );
                })}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Decode a server error body — the route returns JSON; the SDK surfaces the raw text. */
function agentErrorText(error: Error): string {
  try {
    const parsed = JSON.parse(error.message) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    /* not JSON — use the message as-is */
  }
  return error.message;
}

// The agent's chat state lives OUTSIDE the component so it survives the panel
// unmounting on a view switch (Mail/Calendar/Agent swap via AnimatePresence —
// useChat's own state is per-mount). A shared Chat instance plus module-level
// stores keep the conversation, resolved cards, and unsent input intact. Created
// lazily so the constructor only ever runs on the client.
let agentChatRef: Chat<UIMessage> | undefined;
function agentChat(): Chat<UIMessage> {
  agentChatRef ??= new Chat<UIMessage>({
    id: "helm-agent",
    transport: new DefaultChatTransport({ api: "/api/agent" }),
  });
  return agentChatRef;
}
const resolvedStore: Record<string, CardState> = {};
let inputStore = "";
// The id of the conversation currently loaded in the singleton Chat. Created
// lazily on the first send of a fresh chat and persisted (with the thread) to
// the DB so History can resume it. Module-level so it survives a view switch.
let currentConversationId = "";
function newConversationId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `c-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

/** First user line, used as the History list title. */
function deriveTitle(messages: UIMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const part = firstUser?.parts.find((p) => p.type === "text");
  const text = part && "text" in part ? part.text : "";
  return text.trim().replace(/\s+/g, " ").slice(0, 80) || "New conversation";
}

/** Drop staged-action cards before persisting: their signed tokens expire, so a
 *  resumed thread must never show a stale, clickable destructive confirmation. */
function sanitizeForSave(messages: UIMessage[]): UIMessage[] {
  return messages.map((m) => ({
    ...m,
    parts: m.parts.filter((p) => p.type !== "data-pendingAction"),
  }));
}

function relTime(value: Date | string): string {
  const date = new Date(value);
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function AgentPanel({ account }: { account: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Seed from the module stores so a remount (view switch) restores state.
  const [input, setInputState] = useState(inputStore);
  const setInput = (v: string) => {
    inputStore = v;
    setInputState(v);
  };

  const { messages, sendMessage, setMessages, status, error } = useChat({
    chat: agentChat(),
  });

  const busy = status === "submitted" || status === "streaming";
  const [historyOpen, setHistoryOpen] = useState(false);
  // Files attached to the NEXT turn (uploaded or picked from mail), each parsed
  // to text before it can be sent.
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Which staged actions the user has resolved, keyed by signed token. Persisted
  // in a module store so a confirmed card doesn't reset to live buttons after a
  // view switch — which would re-invite a click on a destructive action.
  const [resolved, setResolved] = useState<Record<string, CardState>>(() => ({
    ...resolvedStore,
  }));
  function markResolved(token: string, state: Exclude<CardState, undefined>) {
    resolvedStore[token] = state;
    setResolved({ ...resolvedStore });
  }
  function confirmAction(token: string) {
    if (resolved[token] || busy) return;
    markResolved(token, "confirmed");
    // The token is HMAC-signed: the server replays the EXACT action it encodes,
    // never a write the model re-chooses. The text is just the visible bubble.
    void sendMessage({ text: "Confirm" }, { body: { confirm: token } });
  }
  function denyAction(token: string) {
    if (resolved[token] || busy) return;
    markResolved(token, "denied");
  }

  // The agent acts on real mail and events server-side; when a run ends,
  // refetch every data view so its work is visible immediately.
  const utils = api.useUtils();
  const historyQuery = api.conversations.list.useQuery(undefined, {
    staleTime: 10_000,
  });
  const history = historyQuery.data?.items ?? [];
  const saveConversation = api.conversations.save.useMutation({
    onSuccess: () => void utils.conversations.list.invalidate(),
  });
  const removeConversation = api.conversations.remove.useMutation({
    onSuccess: () => void utils.conversations.list.invalidate(),
  });
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      void utils.gmail.searchEmails.invalidate();
      void utils.gmail.listDrafts.invalidate();
      void utils.triage.overview.invalidate();
      void utils.calendar.searchEvents.invalidate();
      // Persist the settled thread so History can resume it later.
      if (messages.length > 0) {
        if (!currentConversationId) currentConversationId = newConversationId();
        saveConversation.mutate({
          id: currentConversationId,
          title: deriveTitle(messages),
          messages: sanitizeForSave(messages),
        });
      }
    }
    wasBusy.current = busy;
  }, [busy, utils, messages, saveConversation]);

  function newChat() {
    if (busy) return;
    setMessages([]);
    currentConversationId = "";
    setHistoryOpen(false);
    setInput("");
    inputRef.current?.focus();
  }

  async function loadConversation(id: string) {
    if (busy) return;
    const data = await utils.conversations.get.fetch({ id });
    if (!data) return;
    setMessages((data.messages as UIMessage[]) ?? []);
    currentConversationId = id;
    setHistoryOpen(false);
  }

  function deleteConversation(id: string) {
    removeConversation.mutate({ id });
    if (id === currentConversationId) {
      setMessages([]);
      currentConversationId = "";
    }
  }

  // Mail attachments the user can attach (text-bearing types only — images
  // can't be read as text). Loaded only while the attach popover is open.
  const docsForPicker = api.documents.list.useQuery(
    { account, limit: 40 },
    { enabled: attachOpen, staleTime: 30_000 },
  );
  const pickerDocs = (docsForPicker.data?.items ?? []).filter(
    (d) =>
      ["pdf", "doc", "sheet", "other"].includes(d.category) &&
      (pickerSearch.trim() === "" ||
        d.filename.toLowerCase().includes(pickerSearch.trim().toLowerCase())),
  );
  const extractText = api.documents.extractText.useMutation();

  function patchAttachment(key: string, patch: Partial<PendingAttachment>) {
    setPending((prev) =>
      prev.map((a) => (a.key === key ? { ...a, ...patch } : a)),
    );
  }
  function removeAttachment(key: string) {
    setPending((prev) => prev.filter((a) => a.key !== key));
  }

  async function uploadFiles(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      const key = newConversationId();
      setPending((prev) => [
        ...prev,
        {
          key,
          name: file.name || "file",
          mimeType: file.type,
          text: "",
          status: "loading",
        },
      ]);
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/agent/attach", { method: "POST", body: form });
        const data = (await res.json()) as {
          name?: string;
          mimeType?: string;
          text?: string;
          error?: string;
        };
        if (!res.ok || !data.text) {
          throw new Error(data.error ?? "Couldn't read that file.");
        }
        patchAttachment(key, {
          text: data.text,
          mimeType: data.mimeType ?? file.type,
          status: "ready",
        });
      } catch (e) {
        patchAttachment(key, {
          status: "error",
          error: e instanceof Error ? e.message : "Upload failed.",
        });
      }
    }
  }

  async function attachFromMail(doc: {
    accountId: string;
    messageId: string;
    attachmentId: string;
    filename: string;
    mimeType: string;
  }) {
    const key = `${doc.accountId}:${doc.messageId}:${doc.attachmentId}`;
    setAttachOpen(false);
    if (pending.some((a) => a.key === key)) return;
    setPending((prev) => [
      ...prev,
      { key, name: doc.filename, mimeType: doc.mimeType, text: "", status: "loading" },
    ]);
    try {
      const data = await extractText.mutateAsync({
        account: doc.accountId,
        messageId: doc.messageId,
        attachmentId: doc.attachmentId,
      });
      patchAttachment(key, { text: data.text, name: data.name, status: "ready" });
    } catch (e) {
      patchAttachment(key, {
        status: "error",
        error: e instanceof Error ? e.message : "Couldn't read that attachment.",
      });
    }
  }

  // Show a thinking skeleton whenever the agent is busy but no text is
  // visibly streaming: before the first token, and between tool steps.
  const last = messages[messages.length - 1];
  // Ignore trailing data parts (sources/suggestions/card) so the answer being
  // followed by a citations block doesn't re-trip the "working" skeleton.
  const lastContentPart = last?.parts
    .filter((p) => p.type === "text" || p.type.startsWith("tool-"))
    .at(-1);
  const thinking =
    busy &&
    (!last ||
      last.role === "user" ||
      (last.role === "assistant" && lastContentPart?.type !== "text"));

  function submit(text: string) {
    const ready = pending.filter((a) => a.status === "ready");
    const anyLoading = pending.some((a) => a.status === "loading");
    const trimmed = text.trim();
    // Nothing to send, still parsing an attachment, or a turn is in flight.
    if ((!trimmed && ready.length === 0) || anyLoading || busy) return;
    // Open a conversation id for a fresh chat so the settled thread persists.
    if (!currentConversationId) currentConversationId = newConversationId();
    const meta: AttachmentMeta | undefined = ready.length
      ? { attachments: ready.map((a) => ({ name: a.name, mimeType: a.mimeType })) }
      : undefined;
    // Tell the server which mailbox(es) the user is looking at, plus any attached
    // files' parsed text (context only). The names ride in metadata so the chips
    // persist on the user message in history.
    void sendMessage(
      {
        text: trimmed || "Review the attached file(s) and tell me what I can do with them.",
        ...(meta ? { metadata: meta } : {}),
      },
      {
        body: {
          account,
          ...(ready.length
            ? { attachments: ready.map((a) => ({ name: a.name, text: a.text })) }
            : {}),
        },
      },
    );
    setInput("");
    setPending([]);
  }

  // Keep the newest message in view — but only when the user is already near the
  // bottom, so scrolling up to read history mid-stream isn't yanked back down.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useAction("focus-search", () => inputRef.current?.focus());

  return (
    <div className="agent">
      <div className="agent-bar">
        <button
          type="button"
          className="agent-bar-btn"
          data-on={historyOpen}
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((open) => !open)}
        >
          <HistoryIcon size={15} />
          History
          {history.length > 0 && (
            <span className="agent-bar-count tnum">{history.length}</span>
          )}
        </button>
        <button
          type="button"
          className="agent-bar-btn"
          onClick={newChat}
          disabled={busy || messages.length === 0}
        >
          <PlusIcon size={15} />
          New chat
        </button>
      </div>

      {historyOpen && (
        <div className="agent-history">
          <div className="agent-history-head">
            <span>Chat history</span>
            <div className="agent-history-actions">
              <button
                type="button"
                className="agent-bar-btn"
                onClick={newChat}
                disabled={busy || messages.length === 0}
              >
                <PlusIcon size={14} />
                New
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setHistoryOpen(false)}
                aria-label="Close history"
              >
                <CloseIcon size={16} />
              </button>
            </div>
          </div>
          <div className="agent-history-list">
            {history.length === 0 ? (
              <p className="agent-history-empty">
                No past conversations yet. Your chats are saved here.
              </p>
            ) : (
              history.map((c) => (
                <div
                  key={c.id}
                  className="agent-history-row"
                  data-active={c.id === currentConversationId}
                >
                  <button
                    type="button"
                    className="agent-history-open"
                    onClick={() => void loadConversation(c.id)}
                  >
                    <span className="agent-history-title">
                      {c.title || "New conversation"}
                    </span>
                    <span className="agent-history-time tnum">
                      {relTime(c.updatedAt)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => deleteConversation(c.id)}
                    aria-label="Delete conversation"
                    title="Delete conversation"
                  >
                    <TrashIcon size={14} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <div className="agent-scroll" ref={scrollRef}>
        <div className="agent-thread">
          {messages.length === 0 && (
            <div className="agent-empty">
              <AgentIcon size={26} />
              <h2>Ask, and it happens.</h2>
              <p>
                The agent works on your real mail and calendar — searching,
                summarising, drafting, sending, scheduling.
              </p>
              <div className="agent-suggest">
                {SUGGESTIONS.map((text) => (
                  <button
                    key={text}
                    type="button"
                    onClick={() => submit(text)}
                  >
                    {text}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message) => (
            <motion.div
              key={message.id}
              className="agent-msg"
              data-role={message.role}
              variants={listRow}
              initial="initial"
              animate="animate"
              custom={0}
            >
              {message.parts.map((part, i) => {
                if (part.type === "text") {
                  // Suppress per-step narration: the weak model writes a line
                  // before every tool call despite the prompt. Any assistant text
                  // FOLLOWED by a tool call is intermediate chatter — only the
                  // final text (nothing tool-like after it) is the real answer.
                  const toolAfter = message.parts
                    .slice(i + 1)
                    .some((p) => p.type.startsWith("tool-"));
                  if (message.role === "assistant" && toolAfter) return null;
                  return message.role === "assistant" ? (
                    <AgentText key={`${message.id}-t${i}`} text={part.text} />
                  ) : (
                    <p className="agent-text" key={`${message.id}-t${i}`}>
                      {part.text}
                    </p>
                  );
                }
                if (part.type === "data-pendingAction") {
                  const data = part.data as PendingAction;
                  return (
                    <ActionCard
                      key={data.token}
                      summary={data.summary}
                      state={resolved[data.token]}
                      busy={busy}
                      onConfirm={() => confirmAction(data.token)}
                      onDeny={() => denyAction(data.token)}
                    />
                  );
                }
                if (part.type === "data-sources") {
                  const data = part.data as { sources: HelmSource[] };
                  return (
                    <Sources key={`${message.id}-src`} sources={data.sources} />
                  );
                }
                if (part.type.startsWith("tool-")) {
                  const state =
                    "state" in part ? String(part.state) : "input-available";
                  const input = "input" in part ? part.input : undefined;
                  const output = "output" in part ? part.output : undefined;
                  return (
                    <span
                      className="agent-tool tnum"
                      data-done={state === "output-available"}
                      data-error={state === "output-error"}
                      key={`${message.id}-${part.type}-${i}`}
                    >
                      {state === "output-error"
                        ? "Action failed"
                        : toolLabel(part.type, state, input, output)}
                    </span>
                  );
                }
                return null;
              })}
              {message.role === "user" &&
                (() => {
                  const meta = message.metadata as AttachmentMeta | undefined;
                  if (!meta?.attachments?.length) return null;
                  return (
                    <div className="agent-msg-files">
                      {meta.attachments.map((f, i) => (
                        <span className="agent-msg-file" key={i} title={f.name}>
                          <DocumentsIcon size={12} />
                          <span>{f.name}</span>
                        </span>
                      ))}
                    </div>
                  );
                })()}
            </motion.div>
          ))}

          {(() => {
            // Tappable follow-up chips on the latest answer, shown only when idle
            // (tapping one re-enters the loop and clears them; never mid-stream).
            const last = messages[messages.length - 1];
            if (busy || last?.role !== "assistant") return null;
            const part = last.parts.find(
              (p) => p.type === "data-suggestions",
            ) as { data?: Suggestion[] } | undefined;
            const chips = part?.data;
            if (!chips?.length) return null;
            return (
              <div
                className="agent-suggest-follow"
                role="group"
                aria-label="Suggested follow-ups"
              >
                {chips.map((c, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => submit(c.prompt)}
                    title={c.prompt}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            );
          })()}

          {thinking && (
            <div className="agent-msg" data-role="assistant">
              <span className="agent-thinking" aria-label="Agent is working">
                <Skeleton width="58%" height={11} />
                <Skeleton width="36%" height={11} />
              </span>
            </div>
          )}

          {error && (
            <p className="error agent-error">
              The agent hit a problem: {agentErrorText(error)}
            </p>
          )}
        </div>
      </div>

      <div className="agent-compose">
        {pending.length > 0 && (
          <div className="agent-attach-chips">
            {pending.map((a) => (
              <span
                key={a.key}
                className="agent-attach-chip"
                data-status={a.status}
                title={a.error ?? a.name}
              >
                {a.status === "loading" ? (
                  <span className="mini-spinner" />
                ) : (
                  <DocumentsIcon size={12} />
                )}
                <span className="agent-attach-name">{a.name}</span>
                <button
                  type="button"
                  className="agent-attach-x"
                  onClick={() => removeAttachment(a.key)}
                  aria-label={`Remove ${a.name}`}
                >
                  <CloseIcon size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        {attachOpen && (
          <div className="agent-attach-pop">
            <div className="agent-attach-pop-head">
              <button
                type="button"
                className="agent-bar-btn"
                onClick={() => fileInputRef.current?.click()}
              >
                <PaperclipIcon size={14} />
                Upload a file
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setAttachOpen(false)}
                aria-label="Close"
              >
                <CloseIcon size={16} />
              </button>
            </div>
            <input
              className="field agent-attach-search"
              type="text"
              placeholder="Search mail attachments…"
              value={pickerSearch}
              onChange={(e) => setPickerSearch(e.target.value)}
            />
            <div className="agent-attach-list">
              {docsForPicker.isLoading ? (
                <p className="agent-attach-empty">Loading attachments…</p>
              ) : pickerDocs.length === 0 ? (
                <p className="agent-attach-empty">No matching attachments.</p>
              ) : (
                pickerDocs.map((d) => (
                  <button
                    key={`${d.accountId}:${d.messageId}:${d.attachmentId}`}
                    type="button"
                    className="agent-attach-doc"
                    onClick={() => void attachFromMail(d)}
                    title={d.filename}
                  >
                    <DocumentsIcon size={13} />
                    <span className="agent-attach-doc-name">{d.filename}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        <form
          className="agent-inputrow"
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
        >
          <button
            type="button"
            className="agent-attach-btn"
            data-on={attachOpen}
            onClick={() => setAttachOpen((open) => !open)}
            aria-label="Attach a file"
            title="Attach a file"
          >
            <PaperclipIcon size={16} />
          </button>
          <input
            ref={inputRef}
            className="field"
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Tell the agent what to do…"
            onKeyDown={(e) => {
              if (e.key === "Escape") inputRef.current?.blur();
              // Don't let an Enter that only commits an IME candidate submit.
              if (e.key === "Enter" && e.nativeEvent.isComposing) e.preventDefault();
            }}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={
              busy ||
              pending.some((a) => a.status === "loading") ||
              (!input.trim() && !pending.some((a) => a.status === "ready"))
            }
          >
            {busy ? "Working…" : "Send"}
            {!busy && <SendIcon size={14} />}
          </button>
        </form>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,application/pdf"
          multiple
          hidden
          onChange={(e) => {
            void uploadFiles(e.target.files);
            e.target.value = "";
            setAttachOpen(false);
          }}
        />
      </div>
      <p className="agent-fine tnum">
        Acts on your real account. Sends only when you ask it to.
        <Kbd>↵</Kbd>
      </p>
    </div>
  );
}
