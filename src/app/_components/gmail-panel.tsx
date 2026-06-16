"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import { EmailBody } from "@/app/_components/email-body";
import {
  ArchiveIcon,
  CalendarPlusIcon,
  CloseIcon,
  ForwardIcon,
  MailOpenIcon,
  RefreshIcon,
  ReplyIcon,
  StarIcon,
  TrashIcon,
} from "@/components/icons";
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

export type EventSeed = {
  summary: string;
  attendee: string;
  description: string;
};

type Props = {
  composeOpen: boolean;
  onComposeOpenChange: (open: boolean) => void;
  onAddToCalendar: (seed: EventSeed) => void;
};

type LabelOverride = { unread?: boolean; starred?: boolean };
type MessageAction =
  | "archive"
  | "trash"
  | "star"
  | "unstar"
  | "read"
  | "unread";

function senderLabel(raw: string) {
  if (!raw) return "Unknown sender";
  const first = raw.split(",")[0] ?? raw;
  const { name, email } = parseEmailAddress(first);
  return name || email || "Unknown sender";
}

export function GmailPanel({
  composeOpen,
  onComposeOpenChange,
  onAddToCalendar,
}: Props) {
  const [search, setSearch] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [view, setView] = useState<"inbox" | "drafts">("inbox");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [canSyncMore, setCanSyncMore] = useState(true);

  // Optimistic local state: rows removed by archive/trash, and label flips
  // (read/star) that the next refetch will confirm.
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Map<string, LabelOverride>>(
    new Map(),
  );

  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [openingDraftId, setOpeningDraftId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [draftsNotice, setDraftsNotice] = useState<string | null>(null);

  const toRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const utils = api.useUtils();

  const inbox = api.gmail.searchEmails.useInfiniteQuery(
    { query: activeSearch },
    {
      enabled: view === "inbox",
      initialCursor: 0,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );

  // Flatten pages, dedupe across page boundaries, then apply local state.
  const pages = inbox.data?.pages;
  const emails = useMemo(() => {
    const seen = new Set<string>();
    return (pages ?? [])
      .flatMap((page) => page.items)
      .filter((item) => {
        if (seen.has(item.id) || removedIds.has(item.id)) return false;
        seen.add(item.id);
        return true;
      })
      .map((item) => {
        const override = overrides.get(item.id);
        return override ? { ...item, ...override } : item;
      });
  }, [pages, removedIds, overrides]);

  // Debounced read target: the highlight moves instantly; the (slow, live)
  // message fetch fires only once the selection settles.
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
    },
  );

  // True from the moment the selection changes until its message is in.
  const readPending =
    selectedId !== readId || (!!readId && selectedEmail.isLoading);

  const drafts = api.gmail.listDrafts.useQuery(
    { limit: 50, offset: 0 },
    { enabled: view === "drafts" },
  );

  const refreshInbox = api.gmail.refreshInbox.useMutation({
    onSuccess: async () => {
      setCanSyncMore(true);
      setRemovedIds(new Set());
      setOverrides(new Map());
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

  const modifyMessage = api.gmail.modifyMessage.useMutation({
    onError: async () => {
      // The optimistic state was wrong — resync with the server.
      setRemovedIds(new Set());
      setOverrides(new Map());
      await utils.gmail.searchEmails.invalidate();
    },
  });

  function closeCompose() {
    setTo("");
    setSubject("");
    setBody("");
    setEditingDraftId(null);
    onComposeOpenChange(false);
  }

  const createDraft = api.gmail.createDraft.useMutation({
    onSuccess: async () => {
      await utils.gmail.listDrafts.invalidate();
      closeCompose();
    },
  });

  const updateDraft = api.gmail.updateDraft.useMutation();

  const deleteDraft = api.gmail.deleteDraft.useMutation({
    onSuccess: async () => {
      setConfirmDeleteId(null);
      await utils.gmail.listDrafts.invalidate();
    },
  });

  const sendEmail = api.gmail.sendEmail.useMutation({
    onSuccess: async () => {
      await utils.gmail.searchEmails.invalidate();
      closeCompose();
    },
  });

  const sendDraft = api.gmail.sendDraft.useMutation({
    onSuccess: async () => {
      await utils.gmail.searchEmails.invalidate();
      await utils.gmail.listDrafts.invalidate();
    },
  });

  // ---- message actions ----------------------------------------------------

  function setOverride(id: string, patch: LabelOverride) {
    setOverrides((prev) => {
      const next = new Map(prev);
      next.set(id, { ...next.get(id), ...patch });
      return next;
    });
  }

  // Archive/trash: remove the row optimistically and advance the selection
  // to the next message so triage never breaks stride.
  function removeAndAdvance(id: string) {
    const index = emails.findIndex((email) => email.id === id);
    const next = emails[index + 1] ?? emails[index - 1];
    setRemovedIds((prev) => new Set(prev).add(id));
    if (selectedId === id) setSelectedId(next?.id ?? null);
  }

  function act(id: string, action: MessageAction) {
    if (action === "archive" || action === "trash") {
      removeAndAdvance(id);
    } else if (action === "star" || action === "unstar") {
      setOverride(id, { starred: action === "star" });
    } else {
      setOverride(id, { unread: action === "unread" });
    }
    modifyMessage.mutate({ id, action });
  }

  const selectedMeta = emails.find((email) => email.id === selectedId);

  function toggleStar() {
    if (!selectedId) return;
    act(selectedId, selectedMeta?.starred ? "unstar" : "star");
  }

  function toggleUnread() {
    if (!selectedId) return;
    act(selectedId, selectedMeta?.unread ? "read" : "unread");
  }

  // Opening a message marks it read, like every mail client.
  useEffect(() => {
    if (!readId || !selectedEmail.data) return;
    const meta = emails.find((email) => email.id === readId);
    if (meta?.unread) {
      setOverride(readId, { unread: false });
      modifyMessage.mutate({ id: readId, action: "read" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readId, selectedEmail.data]);

  // ---- compose seeds --------------------------------------------------------

  function replyToSelection() {
    const message = selectedEmail.data;
    if (!message) return;
    const sender = parseEmailAddress((message.from || "").split(",")[0] ?? "");
    if (!sender.email) return;
    setEditingDraftId(null);
    setTo(sender.email);
    setSubject(
      message.subject && !/^re:/i.test(message.subject)
        ? `Re: ${message.subject}`
        : (message.subject ?? ""),
    );
    onComposeOpenChange(true);
  }

  function forwardSelection() {
    const message = selectedEmail.data;
    if (!message) return;
    setEditingDraftId(null);
    setTo("");
    setSubject(
      message.subject && !/^fwd:/i.test(message.subject)
        ? `Fwd: ${message.subject}`
        : (message.subject ?? ""),
    );
    setBody(
      [
        "",
        "",
        "---------- Forwarded message ----------",
        `From: ${message.from}`,
        message.date ? `Date: ${formatMessageDate(message.date)}` : "",
        `Subject: ${message.subject}`,
        "",
        message.body || message.snippet || "",
      ].join("\n"),
    );
    onComposeOpenChange(true);
  }

  // Email-to-calendar: schedule a meeting with the sender in two keys.
  function eventFromSelection() {
    const message = selectedEmail.data;
    if (!message) return;
    const sender = parseEmailAddress((message.from || "").split(",")[0] ?? "");
    onAddToCalendar({
      summary: message.subject || "Meeting",
      attendee: sender.email,
      description: `Follow-up on "${message.subject}" — ${message.snippet}`.slice(
        0,
        400,
      ),
    });
  }

  // ---- drafts ----------------------------------------------------------------

  async function openDraft(draftId: string) {
    setOpeningDraftId(draftId);
    setDraftsNotice(null);
    try {
      const draft = await utils.gmail.getDraft.fetch({ id: draftId });
      setEditingDraftId(draftId);
      setTo(draft.to);
      setSubject(draft.subject);
      setBody(draft.body);
      onComposeOpenChange(true);
    } catch {
      setDraftsNotice("That draft could not be opened. Try refreshing.");
    } finally {
      setOpeningDraftId(null);
    }
  }

  async function sendEditedDraft() {
    if (!editingDraftId) return;
    await updateDraft.mutateAsync({ draftId: editingDraftId, to, subject, body });
    await sendDraft.mutateAsync({ draftId: editingDraftId });
    closeCompose();
  }

  async function saveEditedDraft() {
    if (!editingDraftId) return;
    await updateDraft.mutateAsync({ draftId: editingDraftId, to, subject, body });
    await utils.gmail.listDrafts.invalidate();
    closeCompose();
  }

  // ---- keyboard layer ----------------------------------------------------------

  // Focus the right field when compose opens (body when replying, since the
  // recipient is prefilled); close on Escape.
  useEffect(() => {
    if (!composeOpen) return;
    const id = window.setTimeout(() => {
      if (toRef.current?.value) bodyRef.current?.focus();
      else toRef.current?.focus();
    }, 60);
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") closeCompose();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composeOpen]);

  // Roving selection: J/K move through the list and the reading pane follows.
  function moveSelection(step: 1 | -1) {
    if (emails.length === 0) return;
    const index = emails.findIndex((email) => email.id === selectedId);
    const next =
      index === -1 ? 0 : Math.min(Math.max(index + step, 0), emails.length - 1);
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
        case "e":
          if (!selectedId) return;
          act(selectedId, "archive");
          break;
        case "#":
          if (!selectedId) return;
          act(selectedId, "trash");
          break;
        case "s":
          toggleStar();
          break;
        case "U":
          toggleUnread();
          break;
        case "r":
          if (!selectedId) return;
          replyToSelection();
          break;
        case "f":
          if (!selectedId) return;
          forwardSelection();
          break;
        case "t":
          if (!selectedId) return;
          eventFromSelection();
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

  // Warm the inbox once when it loads empty (first connect / cold cache).
  const didAutoSync = useRef(false);
  useEffect(() => {
    if (didAutoSync.current) return;
    if (view !== "inbox" || inbox.isLoading) return;
    if (emails.length > 0 || activeSearch.trim()) return;
    didAutoSync.current = true;
    refreshInbox.mutate();
  }, [emails.length, inbox.isLoading, view, activeSearch, refreshInbox]);

  // Infinite scroll: load the next cached page, or page deeper into Gmail
  // when the cache is exhausted.
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

  const composeError =
    createDraft.error ?? sendEmail.error ?? updateDraft.error ?? sendDraft.error;
  const canSend = Boolean(to && subject && body);
  const composeBusy =
    sendEmail.isPending ||
    createDraft.isPending ||
    updateDraft.isPending ||
    sendDraft.isPending;

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
                    data-unread={email.unread}
                    data-mail-id={email.id}
                    onClick={() => setSelectedId(email.id)}
                    variants={listRow}
                    initial="initial"
                    animate="animate"
                    custom={i}
                  >
                    <span className="row-top">
                      {email.unread && <span className="row-dot" />}
                      <span className="row-from">
                        {senderLabel(email.from)}
                      </span>
                      {email.starred && (
                        <span className="row-star">
                          <StarIcon size={11} filled />
                        </span>
                      )}
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
                <div ref={sentinelRef} aria-hidden="true" style={{ height: 1 }} />
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
          {view === "drafts" && draftsNotice && (
            <p className="error" style={{ padding: "0.5rem 0.6rem" }}>
              {draftsNotice}
            </p>
          )}
          {view === "drafts" &&
            drafts.data &&
            (drafts.data.length === 0 ? (
              <p className="muted" style={{ padding: "0.5rem 0.6rem" }}>
                No drafts. Save one from Compose.
              </p>
            ) : (
              drafts.data.map((draft) => (
                <div key={draft.id} className="draft-row">
                  <button
                    type="button"
                    className="draft-main"
                    onClick={() => void openDraft(draft.id)}
                    disabled={openingDraftId === draft.id}
                  >
                    <span className="row-from">
                      {openingDraftId === draft.id ? "Opening…" : "Draft"}
                    </span>
                    {draft.createdAt && (
                      <span className="row-date tnum">
                        {formatMessageDate(new Date(draft.createdAt))}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="link"
                    onClick={() => sendDraft.mutate({ draftId: draft.id })}
                    disabled={sendDraft.isPending}
                  >
                    Send
                  </button>
                  <button
                    type="button"
                    className="link draft-delete"
                    onClick={() =>
                      confirmDeleteId === draft.id
                        ? deleteDraft.mutate({ draftId: draft.id })
                        : setConfirmDeleteId(draft.id)
                    }
                    disabled={deleteDraft.isPending}
                  >
                    {confirmDeleteId === draft.id ? "Confirm" : "Delete"}
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
        ) : readPending ? (
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
          <article>
            <div className="read-actions">
              <button
                type="button"
                className="icon-btn"
                title="Archive ( E )"
                onClick={() => selectedId && act(selectedId, "archive")}
              >
                <ArchiveIcon size={16} />
              </button>
              <button
                type="button"
                className="icon-btn"
                title="Move to trash ( # )"
                onClick={() => selectedId && act(selectedId, "trash")}
              >
                <TrashIcon size={16} />
              </button>
              <button
                type="button"
                className="icon-btn"
                data-on={selectedMeta?.starred}
                title={selectedMeta?.starred ? "Unstar ( S )" : "Star ( S )"}
                onClick={toggleStar}
              >
                <StarIcon size={16} filled={Boolean(selectedMeta?.starred)} />
              </button>
              <button
                type="button"
                className="icon-btn"
                title="Mark unread ( shift U )"
                onClick={toggleUnread}
              >
                <MailOpenIcon size={16} />
              </button>
              <span className="read-actions-divider" />
              <button
                type="button"
                className="icon-btn"
                title="Reply ( R )"
                onClick={replyToSelection}
              >
                <ReplyIcon size={16} />
              </button>
              <button
                type="button"
                className="icon-btn"
                title="Forward ( F )"
                onClick={forwardSelection}
              >
                <ForwardIcon size={16} />
              </button>
              <button
                type="button"
                className="icon-btn"
                title="Turn into calendar event ( T )"
                onClick={eventFromSelection}
              >
                <CalendarPlusIcon size={16} />
              </button>
            </div>
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
              key={selectedEmail.data.id}
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
              onClick={closeCompose}
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
                if (event.key === "Enter" && canSend && !composeBusy) {
                  event.preventDefault();
                  if (editingDraftId) void sendEditedDraft();
                  else sendEmail.mutate({ to, subject, body });
                } else if (
                  event.key.toLowerCase() === "s" &&
                  canSend &&
                  !composeBusy
                ) {
                  event.preventDefault();
                  if (editingDraftId) void saveEditedDraft();
                  else createDraft.mutate({ to, subject, body });
                }
              }}
            >
              <div className="compose-head">
                {editingDraftId ? "Edit draft" : "New message"}
                <span className="topbar-spacer" />
                <button
                  type="button"
                  className="icon-btn"
                  onClick={closeCompose}
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
                  onClick={() =>
                    editingDraftId
                      ? void sendEditedDraft()
                      : sendEmail.mutate({ to, subject, body })
                  }
                  disabled={composeBusy || !canSend}
                >
                  {composeBusy ? "Working…" : "Send"}
                  <Kbd>⌘↵</Kbd>
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    editingDraftId
                      ? void saveEditedDraft()
                      : createDraft.mutate({ to, subject, body })
                  }
                  disabled={composeBusy || !canSend}
                >
                  {editingDraftId ? "Save changes" : "Save draft"}
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
