"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import { EmailBody } from "@/app/_components/email-body";
import { CloseIcon, RefreshIcon } from "@/components/icons";
import { MailRowsSkeleton, ReadingSkeleton } from "@/components/skeleton";
import {
  formatMessageDate,
  formatSender,
  parseEmailAddress,
} from "@/lib/display";
import { listRow, scrim, slideOver } from "@/lib/motion";
import { api } from "@/trpc/react";

type Props = {
  composeOpen: boolean;
  onComposeOpenChange: (open: boolean) => void;
};

function senderLabel(raw: string) {
  if (!raw) return "Unknown sender";
  const first = raw.split(",")[0] ?? raw;
  const { name, email } = parseEmailAddress(first);
  return name || email || "Unknown sender";
}

export function GmailPanel({ composeOpen, onComposeOpenChange }: Props) {
  const [search, setSearch] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [view, setView] = useState<"inbox" | "drafts">("inbox");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const toRef = useRef<HTMLInputElement>(null);

  const utils = api.useUtils();

  const emails = api.gmail.searchEmails.useQuery(
    { query: activeSearch, limit: 50, offset: 0 },
    { enabled: view === "inbox" },
  );

  const selectedEmail = api.gmail.getMessage.useQuery(
    { id: selectedId! },
    {
      enabled: !!selectedId,
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
    },
  );

  const drafts = api.gmail.listDrafts.useQuery(
    { limit: 50, offset: 0 },
    { enabled: view === "drafts" },
  );

  const refreshInbox = api.gmail.refreshInbox.useMutation({
    onSuccess: async () => {
      await utils.gmail.searchEmails.invalidate();
      await utils.gmail.listDrafts.invalidate();
    },
  });

  function resetCompose() {
    setTo("");
    setSubject("");
    setBody("");
  }

  const createDraft = api.gmail.createDraft.useMutation({
    onSuccess: async () => {
      await utils.gmail.listDrafts.invalidate();
      resetCompose();
      onComposeOpenChange(false);
    },
  });

  const sendEmail = api.gmail.sendEmail.useMutation({
    onSuccess: async () => {
      await utils.gmail.searchEmails.invalidate();
      resetCompose();
      onComposeOpenChange(false);
    },
  });

  const sendDraft = api.gmail.sendDraft.useMutation({
    onSuccess: async () => {
      await utils.gmail.searchEmails.invalidate();
      await utils.gmail.listDrafts.invalidate();
    },
  });

  // Focus the first field when compose opens; close it on Escape.
  useEffect(() => {
    if (!composeOpen) return;
    const id = window.setTimeout(() => toRef.current?.focus(), 60);
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onComposeOpenChange(false);
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("keydown", onKey);
    };
  }, [composeOpen, onComposeOpenChange]);

  // Warm the inbox once when it loads empty (first connect / cold cache),
  // so mail appears without the user clicking refresh.
  const didAutoSync = useRef(false);
  useEffect(() => {
    if (didAutoSync.current) return;
    if (view !== "inbox" || emails.isLoading) return;
    if ((emails.data?.length ?? 0) > 0) return;
    didAutoSync.current = true;
    refreshInbox.mutate();
  }, [emails.data, emails.isLoading, view, refreshInbox]);

  const composeError = createDraft.error ?? sendEmail.error;
  const canSend = Boolean(to && subject && body);

  return (
    <div className="mail">
      <div className="mail-list">
        <div className="mail-list-head">
          <div className="seg">
            <button
              type="button"
              data-active={view === "inbox"}
              onClick={() => setView("inbox")}
            >
              Inbox
            </button>
            <button
              type="button"
              data-active={view === "drafts"}
              onClick={() => setView("drafts")}
            >
              Drafts
            </button>
          </div>
          <span className="topbar-spacer" />
          <button
            type="button"
            className="icon-btn"
            title="Refresh from Gmail"
            data-spinning={refreshInbox.isPending}
            onClick={() => refreshInbox.mutate()}
            disabled={refreshInbox.isPending}
          >
            <RefreshIcon size={15} />
          </button>
        </div>

        {view === "inbox" && (
          <form
            className="mail-search"
            onSubmit={(e) => {
              e.preventDefault();
              setActiveSearch(search);
            }}
          >
            <input
              className="field"
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search mail"
            />
          </form>
        )}

        <div className="mail-rows">
          {view === "inbox" && emails.isLoading && <MailRowsSkeleton />}
          {view === "inbox" && emails.error && (
            <p className="error" style={{ padding: "0.5rem 0.6rem" }}>
              {emails.error.message}
            </p>
          )}
          {view === "inbox" &&
            emails.data &&
            (emails.data.length === 0 ? (
              <p className="muted" style={{ padding: "0.5rem 0.6rem" }}>
                {refreshInbox.isPending
                  ? "Syncing your inbox…"
                  : "No mail yet. Refresh from Gmail to sync."}
              </p>
            ) : (
              emails.data.map((email, i) => (
                <motion.button
                  key={email.id}
                  type="button"
                  className="row"
                  data-active={selectedId === email.id}
                  onClick={() => setSelectedId(email.id)}
                  variants={listRow}
                  initial="initial"
                  animate="animate"
                  custom={i}
                >
                  <span className="row-top">
                    <span className="row-from">{senderLabel(email.from)}</span>
                    {email.date && (
                      <span className="row-date tnum">
                        {formatMessageDate(email.date)}
                      </span>
                    )}
                  </span>
                  {email.subject && (
                    <span className="row-subject">{email.subject}</span>
                  )}
                  {email.snippet && (
                    <span className="row-snippet">{email.snippet}</span>
                  )}
                </motion.button>
              ))
            ))}

          {view === "drafts" && drafts.isLoading && (
            <p className="muted" style={{ padding: "0.5rem 0.6rem" }}>
              Loading…
            </p>
          )}
          {view === "drafts" && drafts.error && (
            <p className="error" style={{ padding: "0.5rem 0.6rem" }}>
              {drafts.error.message}
            </p>
          )}
          {view === "drafts" &&
            drafts.data &&
            (drafts.data.length === 0 ? (
              <p className="muted" style={{ padding: "0.5rem 0.6rem" }}>
                No drafts.
              </p>
            ) : (
              drafts.data.map((draft) => (
                <div
                  key={draft.id}
                  className="row-top"
                  style={{ padding: "0.55rem 0.6rem" }}
                >
                  <span className="row-from">Draft</span>
                  <button
                    type="button"
                    className="link"
                    style={{ marginLeft: "auto" }}
                    onClick={() => sendDraft.mutate({ draftId: draft.id })}
                    disabled={sendDraft.isPending}
                  >
                    Send
                  </button>
                </div>
              ))
            ))}
        </div>
      </div>

      <section className="mail-read">
        {!selectedId ? (
          <div className="empty">
            <p>Select a conversation to read it.</p>
            <p className="tnum">C to compose</p>
          </div>
        ) : selectedEmail.isLoading ? (
          <ReadingSkeleton />
        ) : selectedEmail.error ? (
          <p className="error">{selectedEmail.error.message}</p>
        ) : selectedEmail.data ? (
          <article>
            <h1 className="read-subject">
              {selectedEmail.data.subject || "(no subject)"}
            </h1>
            <div className="read-meta">
              <span>{formatSender(selectedEmail.data.from)}</span>
              {selectedEmail.data.date && (
                <span className="tnum">
                  {formatMessageDate(selectedEmail.data.date)}
                </span>
              )}
            </div>
            <EmailBody
              html={selectedEmail.data.html}
              text={selectedEmail.data.body || selectedEmail.data.snippet}
            />
          </article>
        ) : null}
      </section>

      <AnimatePresence>
        {composeOpen && (
          <>
            <motion.div
              className="scrim"
              variants={scrim}
              initial="initial"
              animate="animate"
              exit="exit"
              onClick={() => onComposeOpenChange(false)}
            />
            <motion.div
              className="compose"
              variants={slideOver}
              initial="initial"
              animate="animate"
              exit="exit"
              role="dialog"
              aria-label="Compose message"
            >
              <div className="compose-head">
                New message
                <span className="topbar-spacer" />
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => onComposeOpenChange(false)}
                  aria-label="Close"
                >
                  <CloseIcon size={16} />
                </button>
              </div>
              <div className="compose-body">
                <input
                  ref={toRef}
                  className="field"
                  type="email"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="To"
                />
                <input
                  className="field"
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Subject"
                />
                <textarea
                  className="field"
                  rows={8}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Write your message…"
                />
                {composeError && <p className="error">{composeError.message}</p>}
              </div>
              <div className="compose-foot">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => sendEmail.mutate({ to, subject, body })}
                  disabled={sendEmail.isPending || !canSend}
                >
                  {sendEmail.isPending ? "Sending…" : "Send"}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => createDraft.mutate({ to, subject, body })}
                  disabled={createDraft.isPending || !canSend}
                >
                  {createDraft.isPending ? "Saving…" : "Save draft"}
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
