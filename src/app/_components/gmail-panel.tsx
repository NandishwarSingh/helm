"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";

import { EmailBody } from "@/app/_components/email-body";
import { CloseIcon, RefreshIcon } from "@/components/icons";
import { Kbd } from "@/components/kbd";
import { MailRowsSkeleton, ReadingSkeleton } from "@/components/skeleton";
import { hasOverlay, isTypingTarget, useAction } from "@/lib/actions";
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
  const [canSyncMore, setCanSyncMore] = useState(true);

  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const toRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const utils = api.useUtils();

  const inbox = api.gmail.searchEmails.useInfiniteQuery(
    { query: activeSearch },
    {
      enabled: view === "inbox",
      initialCursor: 0,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );

  // Flatten pages and drop any duplicates that straddle page boundaries.
  const pages = inbox.data?.pages;
  const emails = useMemo(() => {
    const seen = new Set<string>();
    return (pages ?? [])
      .flatMap((page) => page.items)
      .filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });
  }, [pages]);

  const sentinelRef = useRef<HTMLDivElement>(null);

  // Debounced read target: while J/K flies through the list, the highlight
  // moves instantly but the (slow, live) message fetch fires only once the
  // selection settles, so a fast scroll doesn't stack dozens of Google calls.
  const [readId, setReadId] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedId) {
      setReadId(null);
      return;
    }
    const id = window.setTimeout(() => setReadId(selectedId), 200);
    return () => window.clearTimeout(id);
  }, [selectedId]);

  const selectedEmail = api.gmail.getMessage.useQuery(
    { id: readId! },
    {
      enabled: !!readId,
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
      retry: 1,
      // Keep the previous message visible while the next one loads.
      placeholderData: keepPreviousData,
    },
  );

  const drafts = api.gmail.listDrafts.useQuery(
    { limit: 50, offset: 0 },
    { enabled: view === "drafts" },
  );

  const refreshInbox = api.gmail.refreshInbox.useMutation({
    onSuccess: async () => {
      setCanSyncMore(true);
      await utils.gmail.searchEmails.invalidate();
      await utils.gmail.listDrafts.invalidate();
    },
  });

  // Pulls older mail from Gmail when the cached list runs out (infinite scroll).
  const syncMore = api.gmail.syncMore.useMutation({
    onSuccess: async (result) => {
      setCanSyncMore(result.hasMore);
      if (result.synced > 0) await utils.gmail.searchEmails.invalidate();
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

  // Focus the right field when compose opens (body when replying, since the
  // recipient is prefilled); close on Escape.
  useEffect(() => {
    if (!composeOpen) return;
    const id = window.setTimeout(() => {
      if (toRef.current?.value) bodyRef.current?.focus();
      else toRef.current?.focus();
    }, 60);
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onComposeOpenChange(false);
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("keydown", onKey);
    };
  }, [composeOpen, onComposeOpenChange]);

  // Reply: prefill the recipient and subject from the open message.
  function replyToSelection() {
    const message = selectedEmail.data;
    if (!message) return;
    const sender = parseEmailAddress(
      (message.from || "").split(",")[0] ?? "",
    );
    if (!sender.email) return;
    setTo(sender.email);
    setSubject(
      message.subject && !/^re:/i.test(message.subject)
        ? `Re: ${message.subject}`
        : (message.subject ?? ""),
    );
    onComposeOpenChange(true);
  }

  // Roving selection: J/K move through the list and the reading pane follows.
  function moveSelection(step: 1 | -1) {
    if (emails.length === 0) return;
    const index = emails.findIndex((email) => email.id === selectedId);
    const next =
      index === -1
        ? 0
        : Math.min(Math.max(index + step, 0), emails.length - 1);
    const target = emails[next];
    if (!target) return;
    setSelectedId(target.id);
    document
      .querySelector(`[data-mail-id="${target.id}"]`)
      ?.scrollIntoView({ block: "nearest" });
    // Nearing the end of the loaded list: pull the next page in early.
    if (next >= emails.length - 3 && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }

  // Mail keyboard layer. Suspended while typing or while an overlay is open.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) {
        // Esc inside search: revert the draft text and return to the list.
        if (event.key === "Escape" && event.target === searchRef.current) {
          setSearch(activeSearch);
          searchRef.current?.blur();
        }
        return;
      }
      if (hasOverlay()) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.key) {
        case "j":
        case "ArrowDown":
          if (view !== "inbox") return;
          moveSelection(1);
          break;
        case "k":
        case "ArrowUp":
          if (view !== "inbox") return;
          moveSelection(-1);
          break;
        case "Enter":
        case "o":
          if (view !== "inbox" || emails.length === 0) return;
          if (!selectedId) setSelectedId(emails[0]?.id ?? null);
          break;
        case "u":
        case "Escape":
          if (!selectedId) return;
          setSelectedId(null);
          break;
        case "r":
          if (!selectedId) return;
          replyToSelection();
          break;
        case "i":
          setView("inbox");
          break;
        case "d":
          setView("drafts");
          break;
        default:
          return;
      }
      event.preventDefault();
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Palette / global-shortcut hooks.
  useAction("focus-search", () => {
    searchRef.current?.focus();
    searchRef.current?.select();
  });
  useAction("refresh", () => {
    if (!refreshInbox.isPending) refreshInbox.mutate();
  });

  // Warm the inbox once when it loads empty (first connect / cold cache),
  // so mail appears without the user clicking refresh.
  const didAutoSync = useRef(false);
  useEffect(() => {
    if (didAutoSync.current) return;
    if (view !== "inbox" || inbox.isLoading) return;
    if (emails.length > 0 || activeSearch.trim()) return;
    didAutoSync.current = true;
    refreshInbox.mutate();
  }, [emails.length, inbox.isLoading, view, activeSearch, refreshInbox]);

  // Infinite scroll: load the next cached page, or page deeper into Gmail when
  // the cache is exhausted.
  const { hasNextPage, isFetchingNextPage, isFetching, fetchNextPage } = inbox;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || view !== "inbox") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        if (hasNextPage && !isFetchingNextPage) {
          void fetchNextPage();
        } else if (
          !hasNextPage &&
          !isFetching &&
          !activeSearch.trim() &&
          canSyncMore &&
          !syncMore.isPending
        ) {
          syncMore.mutate();
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [
    view,
    hasNextPage,
    isFetchingNextPage,
    isFetching,
    fetchNextPage,
    activeSearch,
    canSyncMore,
    syncMore,
  ]);

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
            <div className="search-wrap">
              <input
                ref={searchRef}
                className="field"
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search mail"
              />
              <Kbd>/</Kbd>
            </div>
          </form>
        )}

        <div className="mail-rows">
          {view === "inbox" && inbox.isLoading && <MailRowsSkeleton />}
          {view === "inbox" && inbox.error && (
            <p className="error" style={{ padding: "0.5rem 0.6rem" }}>
              {inbox.error.message}
            </p>
          )}
          {view === "inbox" &&
            !inbox.isLoading &&
            !inbox.error &&
            (emails.length === 0 ? (
              refreshInbox.isPending ? (
                <MailRowsSkeleton />
              ) : (
                <p className="muted" style={{ padding: "0.5rem 0.6rem" }}>
                  No mail yet. Refresh from Gmail to sync.
                </p>
              )
            ) : (
              <>
                {emails.map((email, i) => (
                  <motion.button
                    key={email.id}
                    type="button"
                    className="row"
                    data-active={selectedId === email.id}
                    data-mail-id={email.id}
                    onClick={() => setSelectedId(email.id)}
                    variants={listRow}
                    initial="initial"
                    animate="animate"
                    custom={i}
                  >
                    <span className="row-top">
                      <span className="row-from">
                        {senderLabel(email.from)}
                      </span>
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
                ))}
                {(inbox.isFetchingNextPage || syncMore.isPending) && (
                  <MailRowsSkeleton count={3} />
                )}
                <div
                  ref={sentinelRef}
                  aria-hidden="true"
                  style={{ height: 1 }}
                />
              </>
            ))}

          {view === "drafts" && drafts.isLoading && (
            <MailRowsSkeleton count={4} />
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
            <p className="tnum">J / K to browse · C to compose · ? for keys</p>
          </div>
        ) : selectedEmail.isLoading ? (
          <ReadingSkeleton />
        ) : selectedEmail.error ? (
          <div className="empty">
            <p className="error">This message could not be loaded.</p>
            <button
              type="button"
              className="btn"
              onClick={() => void selectedEmail.refetch()}
            >
              Try again
            </button>
          </div>
        ) : selectedEmail.data ? (
          <article data-stale={selectedEmail.isFetching}>
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
              onKeyDown={(event) => {
                if (!(event.metaKey || event.ctrlKey)) return;
                if (event.key === "Enter" && canSend && !sendEmail.isPending) {
                  event.preventDefault();
                  sendEmail.mutate({ to, subject, body });
                } else if (
                  event.key.toLowerCase() === "s" &&
                  canSend &&
                  !createDraft.isPending
                ) {
                  event.preventDefault();
                  createDraft.mutate({ to, subject, body });
                }
              }}
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
                  ref={bodyRef}
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
                  <Kbd>⌘↵</Kbd>
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
