"use client";

import { useEffect, useRef, useState } from "react";
import { Chat, useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { motion } from "motion/react";

import { AgentIcon, SendIcon } from "@/components/icons";
import { Kbd } from "@/components/kbd";
import { Skeleton } from "@/components/skeleton";
import { useAction } from "@/lib/actions";
import { formatAccountEmail } from "@/lib/display";
import { listRow } from "@/lib/motion";
import type { ActionSummary } from "@/server/lib/agent-action";
import type { HelmSource } from "@/server/lib/agent-sources";
import type { Suggestion } from "@/server/lib/agent-suggest";
import { api } from "@/trpc/react";

/** What the agent stages for confirmation, carried on a `data-pendingAction` part. */
type PendingAction = { token: string; summary: ActionSummary };
type CardState = "confirmed" | "denied" | undefined;

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

/** Inline rendering: **bold** and `code`, as plain React nodes. */
function inlineCode(text: string, keyBase: string): React.ReactNode[] {
  return text
    .split(/`([^`]+)`/g)
    .map((chunk, i) =>
      i % 2 === 1 ? <code key={`${keyBase}c${i}`}>{chunk}</code> : chunk,
    );
}

function renderInline(text: string): React.ReactNode[] {
  return text
    .split(/\*\*([^*]+)\*\*/g)
    .flatMap((chunk, i): React.ReactNode[] =>
      i % 2 === 1
        ? [<strong key={`b${i}`}>{inlineCode(chunk, `b${i}`)}</strong>]
        : inlineCode(chunk, `t${i}`),
    );
}

/**
 * Markdown-lite for agent replies. The prompt constrains the model, but the
 * renderer still defends: paragraphs, hyphen and numbered lists (real
 * numbering), quotes, dividers, headings-as-bold, bold and inline code.
 */
function AgentText({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let ul: string[] = [];
  let ol: string[] = [];
  let quote: string[] = [];
  // Defense: the model is told never to emit code, but if it slips, swallow the
  // whole fenced block (``` or ~~~) so run_script source can never reach the DOM.
  // Track the opening marker so a ``` block isn't closed by a stray ~~~.
  let fence: string | null = null;

  const flush = (key: number) => {
    if (ul.length > 0) {
      blocks.push(
        <ul key={`u${key}`}>
          {ul.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ul>,
      );
      ul = [];
    }
    if (ol.length > 0) {
      blocks.push(
        <ol key={`o${key}`}>
          {ol.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ol>,
      );
      ol = [];
    }
    if (quote.length > 0) {
      blocks.push(
        <blockquote key={`q${key}`}>
          {quote.map((line, i) => (
            <p key={i}>{renderInline(line)}</p>
          ))}
        </blockquote>,
      );
      quote = [];
    }
  };

  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const fenceMatch = /^\s*(```|~~~)/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) {
        flush(i); // close any open list/quote before swallowing
        fence = marker ?? "```";
      } else if (fence === marker) {
        fence = null; // matching close
      }
      return; // never render a fence marker (or a mismatched one inside a fence)
    }
    if (fence !== null) return; // swallow every line inside a code fence
    const hyphen = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const quoted = /^\s*>\s?(.*)$/.exec(line);
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    const rule = /^\s*([-*_]\s*){3,}$/.test(line);

    if (hyphen && !rule) {
      if (ol.length > 0 || quote.length > 0) flush(i);
      ul.push(hyphen[1] ?? "");
      return;
    }
    if (numbered) {
      if (ul.length > 0 || quote.length > 0) flush(i);
      ol.push(numbered[1] ?? "");
      return;
    }
    if (quoted && line.trim() !== ">") {
      if (ul.length > 0 || ol.length > 0) flush(i);
      if (quoted[1]) quote.push(quoted[1]);
      return;
    }
    flush(i);
    if (rule) {
      blocks.push(<span className="agent-hr" key={`r${i}`} />);
      return;
    }
    if (heading) {
      blocks.push(
        <p className="agent-h" key={`h${i}`}>
          {renderInline(heading[1] ?? "")}
        </p>,
      );
      return;
    }
    if (line.trim()) {
      blocks.push(<p key={`p${i}`}>{renderInline(line)}</p>);
    }
  });
  flush(lines.length);

  return <div className="agent-text">{blocks}</div>;
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

/** End-of-answer citations: the real emails/events the agent's reply drew on. */
function Sources({ sources }: { sources: HelmSource[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="agent-sources">
      <p className="agent-sources-label">Sources</p>
      <ol>
        {sources.map((s) => (
          <li key={`${s.accountId}:${s.id}`}>
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

export function AgentPanel({ account }: { account: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Seed from the module stores so a remount (view switch) restores state.
  const [input, setInputState] = useState(inputStore);
  const setInput = (v: string) => {
    inputStore = v;
    setInputState(v);
  };

  const { messages, sendMessage, status, error } = useChat({ chat: agentChat() });

  const busy = status === "submitted" || status === "streaming";

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
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      void utils.gmail.searchEmails.invalidate();
      void utils.gmail.listDrafts.invalidate();
      void utils.triage.overview.invalidate();
      void utils.calendar.searchEvents.invalidate();
    }
    wasBusy.current = busy;
  }, [busy, utils]);

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
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    // Tell the server which mailbox(es) the user is looking at: a specific
    // account id, or "all" so the agent fans out across every connected inbox
    // instead of silently defaulting to one.
    void sendMessage({ text: trimmed }, { body: { account } });
    setInput("");
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

      <form
        className="agent-inputrow"
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
      >
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
          disabled={busy || !input.trim()}
        >
          {busy ? "Working…" : "Send"}
          {!busy && <SendIcon size={14} />}
        </button>
      </form>
      <p className="agent-fine tnum">
        Acts on your real account. Sends only when you ask it to.
        <Kbd>↵</Kbd>
      </p>
    </div>
  );
}
