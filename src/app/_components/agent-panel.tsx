"use client";

import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { motion } from "motion/react";

import { AgentIcon, SendIcon } from "@/components/icons";
import { Kbd } from "@/components/kbd";
import { Skeleton } from "@/components/skeleton";
import { useAction } from "@/lib/actions";
import { listRow } from "@/lib/motion";
import { api } from "@/trpc/react";

const SUGGESTIONS = [
  "Summarize my unread mail",
  "What is on my calendar this week?",
  "Find the last email from Google and archive it",
  "Schedule a 30 minute sync with dev@corsair.dev tomorrow at 9am and email him that I look forward to it",
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

/** Friendly labels for tool activity chips. */
function toolLabel(type: string, state: string, output: unknown): string {
  const name = type.replace(/^tool-/, "");
  const done = state === "output-available";
  const out = (output ?? {}) as Record<string, unknown>;
  const count = typeof out.count === "number" ? ` · ${out.count}` : "";
  switch (name) {
    case "searchMail":
      return done ? `Searched mail${count}` : "Searching mail";
    case "listRecentMail":
      return done ? `Listed inbox${count}` : "Listing inbox";
    case "readEmail":
      return done ? "Read email" : "Reading email";
    case "sendEmail":
      return done ? "Email sent" : "Sending email";
    case "createDraft":
      return done ? "Draft saved" : "Saving draft";
    case "modifyMail":
      return done
        ? `Done: ${typeof out.action === "string" ? out.action : "updated"}`
        : "Updating mail";
    case "listEvents":
      return done ? `Checked calendar${count}` : "Checking calendar";
    case "createEvent":
      return done
        ? out.invitesSent
          ? "Invite sent"
          : "Event created"
        : "Creating event";
    default:
      return done ? name : `${name}…`;
  }
}

export function AgentPanel() {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { messages, sendMessage, status, error } = useChat({
    // A stable id keeps the conversation alive across view switches.
    id: "helm-agent",
    transport: new DefaultChatTransport({ api: "/api/agent" }),
  });

  const busy = status === "submitted" || status === "streaming";

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
  const lastPart = last?.parts[last.parts.length - 1];
  const thinking =
    busy &&
    (!last ||
      last.role === "user" ||
      (last.role === "assistant" && lastPart?.type !== "text"));

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    void sendMessage({ text: trimmed });
    setInput("");
  }

  // Keep the newest message in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
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
                  return message.role === "assistant" ? (
                    <AgentText key={i} text={part.text} />
                  ) : (
                    <p className="agent-text" key={i}>
                      {part.text}
                    </p>
                  );
                }
                if (part.type.startsWith("tool-")) {
                  const state =
                    "state" in part ? String(part.state) : "input-available";
                  const output = "output" in part ? part.output : undefined;
                  return (
                    <span
                      className="agent-tool tnum"
                      data-done={state === "output-available"}
                      data-error={state === "output-error"}
                      key={i}
                    >
                      {state === "output-error"
                        ? "Action failed"
                        : toolLabel(part.type, state, output)}
                    </span>
                  );
                }
                return null;
              })}
            </motion.div>
          ))}

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
              The agent hit a problem: {error.message}
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
