"use client";

import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { motion } from "motion/react";

import { AgentIcon, SendIcon } from "@/components/icons";
import { HelmLoader } from "@/components/helm-loader";
import { Kbd } from "@/components/kbd";
import { useAction } from "@/lib/actions";
import { listRow } from "@/lib/motion";

const SUGGESTIONS = [
  "Summarize my unread mail",
  "What is on my calendar this week?",
  "Find the last email from Google and archive it",
  "Schedule a 30 minute sync with dev@corsair.dev tomorrow at 9am and email him that I look forward to it",
];

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
    transport: new DefaultChatTransport({ api: "/api/agent" }),
  });

  const busy = status === "submitted" || status === "streaming";

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
                  return (
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

          {busy &&
            messages[messages.length - 1]?.role === "user" && (
              <div className="agent-msg" data-role="assistant">
                <HelmLoader size={22} />
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
