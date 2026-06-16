"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import { EmailBody } from "@/app/_components/email-body";
import {
  ArchiveIcon,
  CalendarPlusIcon,
  CheckIcon,
  CloseIcon,
  ForwardIcon,
  InboxIcon,
  MailOpenIcon,
  RefreshIcon,
  ReplyIcon,
  StarIcon,
  TrashIcon,
} from "@/components/icons";
import { Kbd } from "@/components/kbd";
import { MailRowsSkeleton, ReadingSkeleton } from "@/components/skeleton";
import { hasOverlay, isTypingTarget, useAction, useOverlay } from "@/lib/actions";
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
  view: MailView;
  onViewChange: (view: MailView) => void;
  composeOpen: boolean;
  onComposeOpenChange: (open: boolean) => void;
  onAddToCalendar: (seed: EventSeed) => void;
};

type Folder = "inbox" | "starred" | "archived" | "spam" | "trash";
export type MailView = Folder | "drafts";
type LabelOverride = { unread?: boolean; starred?: boolean };
type MessageAction =
  | "archive"
  | "unarchive"
  | "trash"
  | "untrash"
  | "star"
  | "unstar"
  | "read"
  | "unread"
  | "notSpam"
  | "deleteForever";

type Confirm = { kind: "trash" | "delete"; ids: string[] };

// Actions that move a message out of the folder being viewed.
const LEAVES_FOLDER: Record<Folder, MessageAction[]> = {
  inbox: ["archive", "trash", "deleteForever"],
  starred: ["unstar", "archive", "trash", "deleteForever"],
  archived: ["unarchive", "trash", "deleteForever"],
  spam: ["notSpam", "trash", "deleteForever"],
  trash: ["untrash", "deleteForever"],
};

const EMPTY_COPY: Record<Folder, string> = {
  inbox: "No mail here. Refresh from Gmail to sync.",
  starred: "Nothing starred yet. Press S on a message to star it.",
  archived: "Nothing archived yet. Press E on a message to archive it.",
  spam: "No spam. Long may it last.",
  trash: "Trash is empty.",
};

function senderLabel(raw: string) {
  if (!raw) return "Unknown sender";
  const first = raw.split(",")[0] ?? raw;
  const { name, email } = parseEmailAddress(first);
  return name || email || "Unknown sender";
}

export function GmailPanel({
  view,
  onViewChange,
  composeOpen,
  onComposeOpenChange,
  onAddToCalendar,
}: Props) {
  const [search, setSearch] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [canSyncMore, setCanSyncMore] = useState(true);

  // Multiselect + destructive-action confirmation.
  const [bulkIds, setBulkIds] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  useOverlay(confirm !== null);

  // Optimistic local state: rows removed from the current folder, and label
  // flips the next refetch will confirm.
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

  const folder: Folder = view === "drafts" ? "inbox" : view;
  const inMessages = view !== "drafts";

  const inbox = api.gmail.searchEmails.useInfiniteQuery(
    { query: activeSearch, folder },
    {
      enabled: inMessages,
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

  // Spam and trash are excluded from the normal sync; pull them on demand.
  const syncFolder = api.gmail.syncFolder.useMutation({
    onSuccess: async () => {
      await utils.gmail.searchEmails.invalidate();
    },
  });

  const syncMore = api.gmail.syncMore.useMutation({
    onSuccess: async (result) => {
      setCanSyncMore(result.hasMore);
      if (result.synced > 0) await utils.gmail.searchEmails.invalidate();
    },
  });

  const modifyMessage = api.gmail.modifyMessage.useMutation({
    onError: async () => {
      setRemovedIds(new Set());
      setOverrides(new Map());
      await utils.gmail.searchEmails.invalidate();
    },
  });

  const bulkModify = api.gmail.bulkModify.useMutation({
    onSuccess: async () => {
      await utils.gmail.searchEmails.invalidate();
    },
    onError: async () => {
      setRemovedIds(new Set());
      setOverrides(new Map());
      await utils.gmail.searchEmails.invalidate();
    },
  });

  const bulkDelete = api.gmail.bulkDelete.useMutation({
    onSuccess: async () => {
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

  // ---- message actions ------------------------------------------------------

  function setOverride(id: string, patch: LabelOverride) {
    setOverrides((prev) => {
      const next = new Map(prev);
      next.set(id, { ...next.get(id), ...patch });
      return next;
    });
  }

  function removeRows(ids: string[]) {
    const removing = new Set(ids);
    const index = emails.findIndex((email) => email.id === selectedId);
    setRemovedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    if (selectedId && removing.has(selectedId)) {
      const after = emails.filter(
        (email) => !removing.has(email.id) || email.id === selectedId,
      );
      const pos = after.findIndex((email) => email.id === selectedId);
      const next =
        emails.slice(index + 1).find((email) => !removing.has(email.id)) ??
        after[pos - 1];
      setSelectedId(next && !removing.has(next.id) ? next.id : null);
    }
  }

  // Applies an action to one or many messages with optimistic UI.
  function performAction(ids: string[], action: MessageAction) {
    if (ids.length === 0) return;
    if (view !== "drafts" && LEAVES_FOLDER[folder].includes(action)) {
      removeRows(ids);
    } else if (action === "star" || action === "unstar") {
      for (const id of ids) setOverride(id, { starred: action === "star" });
    } else if (action === "read" || action === "unread") {
      for (const id of ids) setOverride(id, { unread: action === "unread" });
    }

    if (action === "deleteForever") {
      if (ids.length === 1) {
        modifyMessage.mutate({ id: ids[0]!, action });
      } else {
        bulkDelete.mutate({ ids });
      }
    } else if (ids.length === 1) {
      modifyMessage.mutate({ id: ids[0]!, action });
    } else {
      bulkModify.mutate({ ids, action });
    }
    setBulkIds(new Set());
  }

  // Trash and permanent delete always pass through a confirmation.
  function requestTrash(ids: string[]) {
    if (ids.length > 0) setConfirm({ kind: "trash", ids });
  }
  function requestDelete(ids: string[]) {
    if (ids.length > 0) setConfirm({ kind: "delete", ids });
  }
  function runConfirm() {
    if (!confirm) return;
    performAction(confirm.ids, confirm.kind === "trash" ? "trash" : "deleteForever");
    setConfirm(null);
  }

  // Confirm dialog keys: Enter confirms, Escape cancels.
  useEffect(() => {
    if (!confirm) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setConfirm(null);
      } else if (event.key === "Enter") {
        event.preventDefault();
        runConfirm();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirm]);

  const selectedMeta = emails.find((email) => email.id === selectedId);

  function toggleStar() {
    if (!selectedId) return;
    performAction([selectedId], selectedMeta?.starred ? "unstar" : "star");
  }
  function toggleUnread() {
    if (!selectedId) return;
    performAction([selectedId], selectedMeta?.unread ? "read" : "unread");
  }
  function toggleBulk(id: string) {
    setBulkIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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

  // ---- compose seeds ----------------------------------------------------------

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

  // ---- drafts -------------------------------------------------------------------

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

  // ---- keyboard layer --------------------------------------------------------------

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
    if (next >= emails.length - 3 && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) {
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
          if (!inMessages) return;
          moveSelection(1);
          break;
        case "k":
        case "ArrowUp":
          if (!inMessages) return;
          moveSelection(-1);
          break;
        case "Enter":
        case "o":
          if (!inMessages || emails.length === 0) return;
          if (!selectedId) setSelectedId(emails[0]?.id ?? null);
          break;
        case "x":
          if (!inMessages || !selectedId) return;
          toggleBulk(selectedId);
          break;
        case "u":
        case "Escape":
          if (bulkIds.size > 0) {
            setBulkIds(new Set());
            break;
          }
          if (!selectedId) return;
          setSelectedId(null);
          break;
        case "e":
          if (!inMessages || !selectedId) return;
          if (folder === "archived") performAction([selectedId], "unarchive");
          else if (folder === "inbox" || folder === "starred")
            performAction([selectedId], "archive");
          else return;
          break;
        case "#":
          if (!inMessages || !selectedId) return;
          if (folder === "spam" || folder === "trash")
            requestDelete([selectedId]);
          else requestTrash([selectedId]);
          break;
        case "s":
          if (!inMessages) return;
          toggleStar();
          break;
        case "U":
          if (!inMessages) return;
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
          onViewChange("inbox");
          break;
        case "d":
          onViewChange("drafts");
          break;
        default:
          return;
      }
      event.preventDefault();
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useAction("focus-search", () => {
    searchRef.current?.focus();
    searchRef.current?.select();
  });
  useAction("refresh", () => {
    if (folder === "spam" || folder === "trash") {
      if (!syncFolder.isPending) syncFolder.mutate({ folder });
    } else if (!refreshInbox.isPending) {
      refreshInbox.mutate();
    }
  });

  // Folder switches (from the rail) reset transient state.
  const prevView = useRef(view);
  useEffect(() => {
    if (prevView.current === view) return;
    prevView.current = view;
    setSelectedId(null);
    setBulkIds(new Set());
    setConfirmDeleteId(null);
  }, [view]);

  // Warm the inbox once when it loads empty (first connect / cold cache).
  const didAutoSync = useRef(false);
  useEffect(() => {
    if (didAutoSync.current) return;
    if (view !== "inbox" || inbox.isLoading) return;
    if (emails.length > 0 || activeSearch.trim()) return;
    didAutoSync.current = true;
    refreshInbox.mutate();
  }, [emails.length, inbox.isLoading, view, activeSearch, refreshInbox]);

  // Spam and trash sync on first open when empty.
  const syncedFolders = useRef(new Set<string>());
  useEffect(() => {
    if (folder !== "spam" && folder !== "trash") return;
    if (inbox.isLoading || emails.length > 0) return;
    if (syncedFolders.current.has(folder)) return;
    syncedFolders.current.add(folder);
    syncFolder.mutate({ folder });
  }, [folder, inbox.isLoading, emails.length, syncFolder]);

  // Infinite scroll within the cache; deep Gmail paging is inbox-only.
  const { hasNextPage, isFetchingNextPage, isFetching, fetchNextPage } = inbox;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !inMessages) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        if (hasNextPage && !isFetchingNextPage) {
          void fetchNextPage();
        } else if (
          folder === "inbox" &&
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
    inMessages,
    folder,
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
  const listBusy = inbox.isLoading || (syncFolder.isPending && emails.length === 0);
  const bulkList = [...bulkIds];

  return (
    <div className="mail">
      <div className="mail-list">
        {bulkIds.size > 0 && inMessages ? (
          <div className="bulk-bar">
            <span className="bulk-count tnum">{bulkIds.size} selected</span>
            {(folder === "inbox" || folder === "starred") && (
              <button
                type="button"
                className="icon-btn"
                data-tip="Archive selected"
                data-tip-pos="down"
                aria-label="Archive selected"
                onClick={() => performAction(bulkList, "archive")}
              >
                <ArchiveIcon size={15} />
              </button>
            )}
            {folder === "archived" && (
              <button
                type="button"
                className="icon-btn"
                data-tip="Move selected to inbox"
                data-tip-pos="down"
                aria-label="Move selected to inbox"
                onClick={() => performAction(bulkList, "unarchive")}
              >
                <InboxIcon size={15} />
              </button>
            )}
            {folder === "spam" && (
              <button
                type="button"
                className="icon-btn"
                data-tip="Not spam — move to inbox"
                data-tip-pos="down"
                aria-label="Not spam"
                onClick={() => performAction(bulkList, "notSpam")}
              >
                <InboxIcon size={15} />
              </button>
            )}
            {folder === "trash" && (
              <button
                type="button"
                className="icon-btn"
                data-tip="Restore selected to inbox"
                data-tip-pos="down"
                aria-label="Restore selected"
                onClick={() => performAction(bulkList, "untrash")}
              >
                <InboxIcon size={15} />
              </button>
            )}
            {folder !== "trash" && folder !== "spam" && (
              <button
                type="button"
                className="icon-btn"
                data-tip="Move selected to trash"
                data-tip-pos="down"
                aria-label="Move selected to trash"
                onClick={() => requestTrash(bulkList)}
              >
                <TrashIcon size={15} />
              </button>
            )}
            {(folder === "trash" || folder === "spam") && (
              <button
                type="button"
                className="icon-btn"
                data-tip="Delete selected forever"
                data-tip-pos="down"
                aria-label="Delete selected forever"
                onClick={() => requestDelete(bulkList)}
              >
                <TrashIcon size={15} />
              </button>
            )}
            <button
              type="button"
              className="icon-btn"
              data-tip="Star selected"
              data-tip-pos="down"
              aria-label="Star selected"
              onClick={() => performAction(bulkList, "star")}
            >
              <StarIcon size={15} />
            </button>
            <button
              type="button"
              className="icon-btn"
              data-tip="Mark selected read"
              data-tip-pos="down"
              aria-label="Mark selected read"
              onClick={() => performAction(bulkList, "read")}
            >
              <MailOpenIcon size={15} />
            </button>
            <button
              type="button"
              className="btn bulk-clear"
              onClick={() => setBulkIds(new Set())}
            >
              Clear
              <Kbd>esc</Kbd>
            </button>
          </div>
        ) : (
          <form
            className="mail-search"
            onSubmit={(e) => {
              e.preventDefault();
              setActiveSearch(search);
            }}
          >
            {inMessages ? (
              <div className="search-wrap">
                <input
                  ref={searchRef}
                  className="field"
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={`Search ${view}`}
                />
                <Kbd>/</Kbd>
              </div>
            ) : (
              <span className="mail-search-label">Drafts</span>
            )}
            <button
              type="button"
              className="icon-btn"
              data-tip="Refresh from Gmail"
              data-tip-pos="down"
              aria-label="Refresh from Gmail"
              data-spinning={refreshInbox.isPending || syncFolder.isPending}
              onClick={() =>
                folder === "spam" || folder === "trash"
                  ? syncFolder.mutate({ folder })
                  : refreshInbox.mutate()
              }
              disabled={refreshInbox.isPending || syncFolder.isPending}
            >
              <RefreshIcon size={15} />
            </button>
          </form>
        )}

        <div className="mail-rows" data-bulk={bulkIds.size > 0}>
          {inMessages && listBusy && <MailRowsSkeleton />}
          {inMessages && inbox.error && (
            <p className="error" style={{ padding: "0.5rem 0.6rem" }}>
              {inbox.error.message}
            </p>
          )}
          {inMessages &&
            !listBusy &&
            !inbox.error &&
            (emails.length === 0 ? (
              refreshInbox.isPending ? (
                <MailRowsSkeleton />
              ) : (
                <p className="muted" style={{ padding: "0.5rem 0.6rem" }}>
                  {EMPTY_COPY[folder]}
                </p>
              )
            ) : (
              <>
                {emails.map((email, i) => (
                  <motion.div
                    key={email.id}
                    className="row"
                    role="button"
                    tabIndex={0}
                    data-active={selectedId === email.id}
                    data-unread={email.unread}
                    data-checked={bulkIds.has(email.id)}
                    data-mail-id={email.id}
                    onClick={() => setSelectedId(email.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") setSelectedId(email.id);
                    }}
                    variants={listRow}
                    initial="initial"
                    animate="animate"
                    custom={i}
                  >
                    <span className="row-lead">
                      <span
                        className="row-check"
                        role="checkbox"
                        aria-checked={bulkIds.has(email.id)}
                        aria-label="Select message"
                        data-checked={bulkIds.has(email.id)}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleBulk(email.id);
                        }}
                      >
                        <CheckIcon size={11} />
                      </span>
                    </span>
                    <span className="row-inner">
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
                    </span>
                  </motion.div>
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
            <p className="tnum">J / K to browse · X to select · ? for keys</p>
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
              {(folder === "inbox" || folder === "starred") && (
                <button
                  type="button"
                  className="icon-btn"
                  data-tip="Archive — E"
                  data-tip-pos="down"
                  aria-label="Archive"
                  onClick={() => selectedId && performAction([selectedId], "archive")}
                >
                  <ArchiveIcon size={16} />
                </button>
              )}
              {folder === "archived" && (
                <button
                  type="button"
                  className="icon-btn"
                  data-tip="Move to inbox — E"
                  data-tip-pos="down"
                  aria-label="Move to inbox"
                  onClick={() =>
                    selectedId && performAction([selectedId], "unarchive")
                  }
                >
                  <InboxIcon size={16} />
                </button>
              )}
              {folder === "spam" && (
                <button
                  type="button"
                  className="icon-btn"
                  data-tip="Not spam — move to inbox"
                  data-tip-pos="down"
                  aria-label="Not spam"
                  onClick={() =>
                    selectedId && performAction([selectedId], "notSpam")
                  }
                >
                  <InboxIcon size={16} />
                </button>
              )}
              {folder === "trash" && (
                <button
                  type="button"
                  className="icon-btn"
                  data-tip="Restore to inbox"
                  data-tip-pos="down"
                  aria-label="Restore to inbox"
                  onClick={() =>
                    selectedId && performAction([selectedId], "untrash")
                  }
                >
                  <InboxIcon size={16} />
                </button>
              )}
              {folder !== "spam" && folder !== "trash" ? (
                <button
                  type="button"
                  className="icon-btn"
                  data-tip="Move to trash — #"
                  data-tip-pos="down"
                  aria-label="Move to trash"
                  onClick={() => selectedId && requestTrash([selectedId])}
                >
                  <TrashIcon size={16} />
                </button>
              ) : (
                <button
                  type="button"
                  className="icon-btn"
                  data-tip="Delete forever — #"
                  data-tip-pos="down"
                  aria-label="Delete forever"
                  onClick={() => selectedId && requestDelete([selectedId])}
                >
                  <TrashIcon size={16} />
                </button>
              )}
              <button
                type="button"
                className="icon-btn"
                data-on={selectedMeta?.starred}
                data-tip={selectedMeta?.starred ? "Unstar — S" : "Star — S"}
                data-tip-pos="down"
                aria-label="Star"
                onClick={toggleStar}
              >
                <StarIcon size={16} filled={Boolean(selectedMeta?.starred)} />
              </button>
              <button
                type="button"
                className="icon-btn"
                data-tip="Mark unread — shift U"
                data-tip-pos="down"
                aria-label="Mark unread"
                onClick={toggleUnread}
              >
                <MailOpenIcon size={16} />
              </button>
              {folder !== "spam" && folder !== "trash" && (
                <>
                  <span className="read-actions-divider" />
                  <button
                    type="button"
                    className="icon-btn"
                    data-tip="Reply — R"
                    data-tip-pos="down"
                    aria-label="Reply"
                    onClick={replyToSelection}
                  >
                    <ReplyIcon size={16} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    data-tip="Forward — F"
                    data-tip-pos="down"
                    aria-label="Forward"
                    onClick={forwardSelection}
                  >
                    <ForwardIcon size={16} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    data-tip="Turn into calendar event — T"
                    data-tip-pos="down"
                    aria-label="Turn into calendar event"
                    onClick={eventFromSelection}
                  >
                    <CalendarPlusIcon size={16} />
                  </button>
                </>
              )}
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
        {confirm && (
          <>
            <motion.div
              className="scrim"
              variants={scrim}
              initial="initial"
              animate="animate"
              exit="exit"
              onClick={() => setConfirm(null)}
            />
            <motion.div
              className="confirm"
              variants={slideOver}
              initial="initial"
              animate="animate"
              exit="exit"
              role="alertdialog"
              aria-label="Confirm action"
            >
              <div className="confirm-body">
                <h2 className="confirm-title">
                  {confirm.kind === "trash"
                    ? `Move ${confirm.ids.length === 1 ? "this message" : `${confirm.ids.length} messages`} to trash?`
                    : `Delete ${confirm.ids.length === 1 ? "this message" : `${confirm.ids.length} messages`} forever?`}
                </h2>
                <p className="confirm-text">
                  {confirm.kind === "trash"
                    ? "You can restore it from Trash later."
                    : "This cannot be undone."}
                </p>
              </div>
              <div className="confirm-foot">
                <button
                  type="button"
                  className="btn"
                  onClick={() => setConfirm(null)}
                >
                  Cancel
                  <Kbd>esc</Kbd>
                </button>
                <button
                  type="button"
                  className="btn btn-danger-solid"
                  onClick={runConfirm}
                >
                  {confirm.kind === "trash" ? "Move to trash" : "Delete forever"}
                  <Kbd>↵</Kbd>
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

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
