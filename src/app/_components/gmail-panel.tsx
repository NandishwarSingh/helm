"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";

// One page worth of rows revealed at a time, up to the server's window cap.
// MAIL_WINDOW MUST equal MAIL_WINDOW in src/server/api/routers/gmail.ts — the
// reading view can't import that server-only module, so the value is mirrored.
// If they drift the list dead-ends: the client caps the limit below what the
// server still reports as hasMore, and deep-sync never fires.
const MAIL_PAGE = 40;
const MAIL_WINDOW = 300;

// One full Gmail sync per page load. Module-scoped so it survives the panel
// remounting on view switches, but resets on a real page reload (a new visit).
let visitSynced = false;

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
  ReplyAllIcon,
  ReplyIcon,
  StarIcon,
  TrashIcon,
} from "@/components/icons";
import { Kbd } from "@/components/kbd";
import { SyncingState } from "@/components/morph-loader";
import { MailRowsSkeleton, ReadingSkeleton } from "@/components/skeleton";
import { parseQuery, queryChips } from "@/lib/search-operators";
import { hasOverlay, isTypingTarget, useAction, useOverlay } from "@/lib/actions";
import { useFocusTrap } from "@/lib/use-focus-trap";
import {
  formatMessageDate,
  formatSender,
  parseEmailAddress,
} from "@/lib/display";
import { chordBar, listRow, scrim, slideOver } from "@/lib/motion";
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
  // The active account selection from the shell: a specific account id, or
  // "all" for the unified inbox across every connected account.
  account: string;
  // False while the first-sync veil is driving the initial refresh, so the
  // panel doesn't fire a duplicate sync underneath it.
  autoSync?: boolean;
};

// Mirrors folderSchema's enum in src/server/lib/mail-view.ts (server-only, so
// it can't be imported here); keep the two in sync.
type Folder = "inbox" | "starred" | "archived" | "spam" | "trash" | "sent";
export type MailView = Folder | "drafts" | "priority";
type PriorityKey = "urgent" | "reply" | "fyi" | "low";
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

type Confirm = { kind: "trash" | "delete" | "draft"; ids: string[] };

// Mutations that can be taken back from the toast, with their reversals.
type UndoableAction = "archive" | "unarchive" | "trash";
type UndoItem = { id: string; account: string | undefined };
type Undo = { items: UndoItem[]; action: UndoableAction };
const UNDO_REVERSE = {
  archive: "unarchive",
  unarchive: "archive",
  trash: "untrash",
} as const satisfies Record<UndoableAction, MessageAction>;

/**
 * Client-side label truth. Every action lands here synchronously, each view
 * derives membership from it, and server refetches reconcile only once all
 * mutations have settled — so a moved message is in its destination folder
 * the instant the key goes down, and an undo can never flicker.
 */
type LabelState = {
  unread: boolean;
  starred: boolean;
  archived: boolean;
  trashed: boolean;
  spam: boolean;
  sent: boolean;
  deleted: boolean;
};

type EmailRow = {
  id: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string | null;
  unread: boolean;
  starred: boolean;
  archived: boolean;
  trashed: boolean;
  spam: boolean;
  sent: boolean;
  timestamp: number;
  reason: string;
  priority: PriorityKey | undefined;
  // Present in the unified ("all") view so per-message ops hit the right mailbox.
  accountId?: string;
  accountEmail?: string;
};

type LocalEdit = { row: EmailRow; state: LabelState };

function stateFromRow(row: EmailRow): LabelState {
  return {
    unread: row.unread,
    starred: row.starred,
    archived: row.archived,
    trashed: row.trashed,
    spam: row.spam,
    sent: row.sent,
    deleted: false,
  };
}

function applyAction(state: LabelState, action: MessageAction): LabelState {
  switch (action) {
    case "archive": return { ...state, archived: true };
    case "unarchive": return { ...state, archived: false };
    case "trash": return { ...state, trashed: true, spam: false, archived: false };
    case "untrash": return { ...state, trashed: false, spam: false, archived: false };
    case "star": return { ...state, starred: true };
    case "unstar": return { ...state, starred: false };
    case "read": return { ...state, unread: false };
    case "unread": return { ...state, unread: true };
    case "notSpam": return { ...state, spam: false, archived: false };
    case "deleteForever": return { ...state, deleted: true };
  }
}

function inFolder(state: LabelState, folder: Folder): boolean {
  if (state.deleted) return false;
  switch (folder) {
    case "inbox": return !state.archived && !state.trashed && !state.spam && !state.sent;
    case "starred": return state.starred && !state.trashed && !state.spam;
    case "archived": return state.archived && !state.trashed && !state.spam;
    case "spam": return state.spam && !state.trashed;
    case "trash": return state.trashed;
    case "sent": return state.sent && !state.trashed;
  }
}

// A row's stable key across the unified view: Gmail ids are unique only WITHIN
// a mailbox, so optimistic state, dedupe, and priority lookups key on
// (accountId, id) to avoid cross-account collisions.
function rowKey(row: { accountId?: string; id: string }): string {
  return `${row.accountId ?? ""}:${row.id}`;
}

function undoLabel(undo: Undo) {
  const count = undo.items.length;
  const what = count === 1 ? "message" : `${count} messages`;
  if (undo.action === "archive") return `Archived ${what}`;
  if (undo.action === "unarchive") return `Moved ${what} to inbox`;
  return `Moved ${what} to trash`;
}

// Actions that move a message out of the folder being viewed.
const LEAVES_FOLDER: Record<Folder, MessageAction[]> = {
  inbox: ["archive", "trash", "deleteForever"],
  starred: ["unstar", "archive", "trash", "deleteForever"],
  archived: ["unarchive", "trash", "deleteForever"],
  spam: ["notSpam", "trash", "deleteForever"],
  trash: ["untrash", "deleteForever"],
  sent: ["trash", "deleteForever"],
};

// E always means "move it where it belongs" for the folder being viewed.
const E_ACTION: Record<Folder, MessageAction> = {
  inbox: "archive",
  starred: "archive",
  archived: "unarchive",
  spam: "notSpam",
  trash: "untrash",
  // Sent mail has no INBOX label, so archive is a harmless no-op (as in Gmail).
  sent: "archive",
};

const EMPTY_COPY: Record<Folder, string> = {
  inbox: "No mail here. Refresh from Gmail to sync.",
  starred: "Nothing starred yet. Press S on a message to star it.",
  archived: "Nothing archived yet. Press E on a message to archive it.",
  spam: "No spam. Long may it last.",
  trash: "Trash is empty.",
  sent: "No sent mail yet.",
};

// The Priority view groups the inbox by LLM verdict, most pressing first.
const PRIORITY_ORDER: PriorityKey[] = ["urgent", "reply", "fyi", "low"];
const PRIORITY_LABELS: Record<PriorityKey, string> = {
  urgent: "Urgent",
  reply: "Needs reply",
  fyi: "Worth a look",
  low: "Everything else",
};
const PRIORITY_CHIPS: Partial<Record<PriorityKey, string>> = {
  urgent: "Urgent",
  reply: "Reply",
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
  account,
  autoSync = true,
}: Props) {
  const [search, setSearch] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [canSyncMore, setCanSyncMore] = useState(true);

  // Multiselect + destructive-action confirmation.
  const [bulkIds, setBulkIds] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  useOverlay(confirm !== null);

  // One undo at a time, Superhuman-style: the latest archive/trash can be
  // taken back for a few seconds (Z or the toast button).
  const [undo, setUndo] = useState<Undo | null>(null);
  const undoTimer = useRef<number | null>(null);
  function pushUndo(next: Undo) {
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    setUndo(next);
    undoTimer.current = window.setTimeout(() => setUndo(null), 7000);
  }
  useEffect(
    () => () => {
      if (undoTimer.current) window.clearTimeout(undoTimer.current);
    },
    [],
  );

  // Optimistic truth: id -> the row and where it now belongs. Applied on top
  // of every folder's query data until the server confirms.
  const [localEdits, setLocalEdits] = useState<Map<string, LocalEdit>>(
    new Map(),
  );
  // Tracked in-flight label mutations; views reconcile with the server only
  // when this hits zero, so chained actions (archive then undo) never let a
  // mid-flight refetch flash stale state.
  const inFlight = useRef(0);

  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  // Threading: set when replying so the sent message nests in its conversation.
  const [replyThread, setReplyThread] = useState<{
    threadId: string;
    inReplyTo: string;
    references: string;
  } | null>(null);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [openingDraftId, setOpeningDraftId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [draftsNotice, setDraftsNotice] = useState<string | null>(null);

  const toRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const readRef = useRef<HTMLElement>(null);
  const composeRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  useFocusTrap(composeRef, composeOpen);
  useFocusTrap(confirmRef, confirm !== null);

  const utils = api.useUtils();

  // The session's accounts — for per-row badges, the compose "from", and whether
  // the unified view + switcher apply.
  const accountsQuery = api.accounts.list.useQuery(undefined, {
    staleTime: 30_000,
  });
  const accountList = accountsQuery.data?.accounts ?? [];
  const multiAccount = accountsQuery.data?.multi ?? false;
  const accountColor = (id: string | undefined): string | null =>
    id ? (accountList.find((a) => a.id === id)?.color ?? null) : null;

  const isPriority = view === "priority";
  const folder: Folder =
    view === "drafts" || view === "priority" ? "inbox" : view;
  const inMessages = view !== "drafts";

  // A growing window into a stable, date-sorted list. Scrolling raises the
  // limit; the same prefix returns on every refetch, so rows never pop in and
  // out. keepPreviousData means raising the limit (or a poll) never blanks the
  // list.
  const [limit, setLimit] = useState(MAIL_PAGE);
  // Reset the window when the folder or active search changes.
  useEffect(() => {
    setLimit(MAIL_PAGE);
  }, [folder, activeSearch]);

  // Browsing a folder uses searchEmails with an empty query; a real search
  // query routes to semantic (vector) search instead of substring matching.
  const searching = inMessages && !isPriority && activeSearch.trim().length > 0;
  const inbox = api.gmail.searchEmails.useQuery(
    { query: "", folder, limit, account },
    {
      enabled: inMessages && !isPriority,
      placeholderData: keepPreviousData,
      // Reads hit the local cache, so polling is cheap — folders stay live
      // without a manual refresh. Pause while a label mutation is in flight
      // so a refetch can never land between the optimistic update and its
      // confirmation. Focus freshness rides on syncNew (it invalidates this
      // query when it finds mail), so a separate focus refetch only double-fetches.
      staleTime: 10_000,
      refetchInterval: () => (inFlight.current > 0 ? false : 45_000),
      refetchOnWindowFocus: false,
    },
  );

  // Unified search: Gmail-style operators (from:/to:/subject:/is:unread…) filter,
  // and free text is ranked server-side by semantic similarity + an adaptive
  // keyword boost — one query, best of both worlds (an offline eval picked it).
  const smart = api.gmail.smartSearch.useQuery(
    { query: activeSearch, folder, limit: 50, account },
    {
      enabled: searching,
      placeholderData: keepPreviousData,
      staleTime: 15_000,
    },
  );

  // Keep the semantic index warm in the background — embeds only new/changed
  // mail (hash-deduped server-side), so it's cheap to run on a timer.
  const reindex = api.gmail.reindexSearch.useMutation();
  const reindexRef = useRef<() => void>(() => undefined);
  reindexRef.current = () => {
    if (!reindex.isPending) reindex.mutate();
  };
  useEffect(() => {
    const first = window.setTimeout(() => reindexRef.current(), 4_000);
    const id = window.setInterval(() => reindexRef.current(), 120_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, []);

  // LLM triage verdicts: drive the Priority view, and badge the inbox.
  const overview = api.triage.overview.useQuery(undefined, {
    enabled: view === "inbox" || isPriority,
    staleTime: 10_000,
    refetchInterval: 60_000,
  });
  const overviewGroups = overview.data?.groups;
  const pendingTriage = overview.data?.pendingCount ?? 0;

  const priorityById = useMemo(() => {
    const map = new Map<string, PriorityKey>();
    if (!overviewGroups) return map;
    for (const priority of PRIORITY_ORDER) {
      for (const message of overviewGroups[priority]) {
        map.set(rowKey(message), priority);
      }
    }
    return map;
  }, [overviewGroups]);

  // Apply local truth on the server list: drop rows that no longer belong
  // here, surface rows that just moved in, and overlay unread/star flips. In
  // the Priority view the source is the triage groups, most urgent first.
  const items = inbox.data?.items;
  const searchItems = smart.data?.items;
  // Chips showing how the query parsed into Corsair operator filters.
  const operatorChips = searching
    ? queryChips(parseQuery(activeSearch)).filter((chip) => chip.key !== "text")
    : [];
  const emails = useMemo(() => {
    // A search query → semantic results, ranked by relevance and cross-folder.
    // Overlay local unread/star edits but keep similarity order (no folder drop).
    if (searching) {
      return (searchItems ?? []).map((item) => {
        const base: EmailRow = {
          ...item,
          reason: "",
          priority: priorityById.get(rowKey(item)),
        };
        const edit = localEdits.get(rowKey(item));
        return edit
          ? { ...base, unread: edit.state.unread, starred: edit.state.starred }
          : base;
      });
    }
    const source: EmailRow[] = isPriority
      ? PRIORITY_ORDER.flatMap((priority) =>
          (overviewGroups?.[priority] ?? []).map((item) => ({
            ...item,
            priority,
          })),
        )
      : (items ?? []).map((item) => ({
          ...item,
          reason: "",
          priority: priorityById.get(rowKey(item)),
        }));

    const seen = new Set<string>();
    const merged: EmailRow[] = [];
    for (const item of source) {
      const key = rowKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      const edit = localEdits.get(key);
      if (!edit) {
        merged.push(item);
        continue;
      }
      if (!inFolder(edit.state, folder)) continue;
      merged.push({
        ...item,
        unread: edit.state.unread,
        starred: edit.state.starred,
      });
    }

    // Rows the local truth says belong here but the cached page predates
    // (e.g. just archived, viewed from Archive). Priority skips additions —
    // a message needs a verdict before it can join a group.
    if (!isPriority) {
      for (const [key, edit] of localEdits) {
        if (seen.has(key) || !inFolder(edit.state, folder)) continue;
        merged.push({
          ...edit.row,
          unread: edit.state.unread,
          starred: edit.state.starred,
        });
      }
    }

    // The server list is already date-sorted; the priority view keeps its
    // verdict-group order instead. Tiebreak equal timestamps on id so locally
    // surfaced rows slot in deterministically (no reshuffle between renders).
    return isPriority
      ? merged
      : merged.sort(
          (a, b) =>
            b.timestamp - a.timestamp ||
            (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
        );
  }, [
    searching,
    searchItems,
    isPriority,
    overviewGroups,
    items,
    priorityById,
    localEdits,
    folder,
  ]);

  // Which account a per-message op targets: in the unified ("all") view it's the
  // row's own account; otherwise the single selected account.
  const accountOf = (id: string): string | undefined =>
    account === "all" ? emails.find((e) => e.id === id)?.accountId : account;
  // Group ids by owning account so a bulk action over the unified view fires one
  // Gmail call per mailbox.
  function groupByPairs(pairs: UndoItem[]): Map<string | undefined, string[]> {
    const groups = new Map<string | undefined, string[]>();
    for (const { id, account } of pairs) {
      const list = groups.get(account) ?? [];
      list.push(id);
      groups.set(account, list);
    }
    return groups;
  }

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

  const readAccount = readId ? accountOf(readId) : undefined;
  const selectedEmail = api.gmail.getMessage.useQuery(
    { id: readId!, account: readAccount },
    {
      enabled: !!readId,
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
      retry: 1,
    },
  );

  // The full conversation for the open message. The reading pane shows the
  // thread when it holds more than one message.
  const threadId = selectedEmail.data?.threadId ?? "";
  const thread = api.gmail.getThread.useQuery(
    { id: threadId, account: readAccount },
    {
      enabled: !!threadId,
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
      retry: 1,
    },
  );
  const threadMessages = thread.data?.messages ?? [];
  const isThread = threadMessages.length > 1;

  // The user's own address, so reply-all never cc's them back to themselves.
  // For reply-all self-exclusion, "self" is the account the OPEN message belongs
  // to — in the unified view that's the row's account, not the active one.
  const myEmail = api.gmail.profile.useQuery(
    { account: account === "all" ? readAccount : account },
    {
      enabled: inMessages,
      staleTime: 60 * 60 * 1000,
    },
  ).data?.email;

  const readPending =
    selectedId !== readId || (!!readId && selectedEmail.isLoading);

  const drafts = api.gmail.listDrafts.useQuery(
    { limit: 50, offset: 0, account },
    { enabled: view === "drafts", staleTime: 10_000, refetchInterval: 60_000 },
  );
  // The mailbox a draft lives in, so its edit/send/delete hit the right account.
  const draftAccountOf = (id: string | null): string | undefined =>
    id ? drafts.data?.find((d) => d.id === id)?.accountId : undefined;

  // Triage runs classify untriaged inbox mail in capped slices; the loop
  // continues until the backlog is clear (bounded per visit).
  const triageRuns = useRef(0);
  const triageRun = api.triage.run.useMutation({
    onSuccess: async (result) => {
      await utils.triage.overview.invalidate();
      if (result.remaining > 0 && triageRuns.current < 5) {
        triageRuns.current += 1;
        triageRun.mutate();
      }
    },
  });

  const refreshInbox = api.gmail.refreshInbox.useMutation({
    onSuccess: async () => {
      setCanSyncMore(true);
      triageRuns.current = 0;
      await utils.gmail.searchEmails.invalidate();
      await utils.gmail.listDrafts.invalidate();
      await utils.triage.overview.invalidate();
      if (inFlight.current === 0) setLocalEdits(new Map());
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

  // Refetch every mail view. Called only once all tracked mutations settle.
  async function refreshMailViews() {
    await Promise.all([
      utils.gmail.searchEmails.invalidate(),
      utils.triage.overview.invalidate(),
    ]);
  }

  // When the last in-flight mutation settles, reconcile with the server and
  // only then drop the local truth — the fresh data already agrees with it.
  async function settleTracked() {
    inFlight.current -= 1;
    if (inFlight.current > 0) return;
    await refreshMailViews();
    if (inFlight.current === 0) setLocalEdits(new Map());
  }
  const trackedCallbacks = {
    onSettled: () => void settleTracked(),
  };

  const modifyMessage = api.gmail.modifyMessage.useMutation({
    onError: async () => {
      setLocalEdits(new Map());
      await refreshMailViews();
    },
  });

  const bulkModify = api.gmail.bulkModify.useMutation({
    onError: async () => {
      setLocalEdits(new Map());
      await refreshMailViews();
    },
  });

  const bulkDelete = api.gmail.bulkDelete.useMutation({
    onError: async () => {
      setLocalEdits(new Map());
      await refreshMailViews();
    },
  });

  // Top-up poll: pull newly arrived Gmail ids so new mail lands on its own.
  // Polls every few seconds while the tab is visible (and instantly the moment
  // it regains focus / becomes visible), so mail shows within seconds without a
  // manual refresh. Stands down entirely when the tab is hidden — the ref guard
  // makes those ticks no-ops. Gmail push (watch → webhook → SSE) would make this
  // truly instant once the app is deployed behind a public URL.
  const NEW_MAIL_POLL_MS = 10_000;
  const syncNew = api.gmail.syncNew.useMutation({
    onSuccess: async (result) => {
      if (result.found > 0) await refreshMailViews();
    },
  });
  const syncNewRef = useRef<() => void>(() => undefined);
  syncNewRef.current = () => {
    if (document.visibilityState !== "visible") return;
    if (!syncNew.isPending && !refreshInbox.isPending) syncNew.mutate();
  };
  useEffect(() => {
    const tick = () => syncNewRef.current();
    const first = window.setTimeout(tick, 2_000);
    const id = window.setInterval(tick, NEW_MAIL_POLL_MS);
    // Both fire when returning to the tab — an immediate catch-up sync.
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  // Realtime push: Corsair webhooks fan a "changed" event out over SSE, so new
  // mail lands the instant Google notifies us — no waiting for the poll. The
  // EventSource auto-reconnects; the poll above stays as a fallback.
  const refreshRef = useRef(refreshMailViews);
  refreshRef.current = refreshMailViews;
  useEffect(() => {
    if (typeof window === "undefined" || !("EventSource" in window)) return;
    const source = new EventSource("/api/stream");
    source.addEventListener("changed", () => void refreshRef.current());
    return () => source.close();
  }, []);

  function closeCompose() {
    setTo("");
    setCc("");
    setBcc("");
    setShowCcBcc(false);
    setSubject("");
    setBody("");
    setReplyThread(null);
    setEditingDraftId(null);
    onComposeOpenChange(false);
  }

  // The mailbox a compose sends from: a reply goes from the account its thread
  // lives in; a fresh compose from the active account (or the primary in "all").
  function composeAccountId(): string | undefined {
    // A reply goes from the account its thread lives in; if that can't be
    // resolved, fall back to primary (never to the active mailbox blindly).
    if (replyThread && selectedId) {
      const resolved = accountOf(selectedId);
      if (resolved) return resolved;
    }
    if (account !== "all") return account;
    return accountList.find((a) => a.isPrimary)?.id ?? accountList[0]?.id;
  }

  // Fields shared by send/draft/update, including Cc/Bcc and any reply thread.
  function composePayload() {
    return {
      to,
      cc: cc.trim() || undefined,
      bcc: bcc.trim() || undefined,
      subject,
      body,
      account: composeAccountId(),
      ...(replyThread ?? {}),
    };
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

  // Records the new label state for each id, synchronously.
  function applyLocal(items: UndoItem[], action: MessageAction) {
    setLocalEdits((prev) => {
      const next = new Map(prev);
      for (const { id, account } of items) {
        const key = `${account ?? ""}:${id}`;
        const existing = next.get(key);
        const row =
          existing?.row ??
          emails.find((e) => e.id === id && e.accountId === account);
        if (!row) continue;
        const state = applyAction(existing?.state ?? stateFromRow(row), action);
        next.set(key, { row, state });
      }
      return next;
    });
  }

  // Moves the cursor off rows that are about to leave the current view.
  function advanceSelectionPast(ids: string[]) {
    const leaving = new Set(ids);
    if (!selectedId || !leaving.has(selectedId)) return;
    const index = emails.findIndex((email) => email.id === selectedId);
    const next =
      emails.slice(index + 1).find((email) => !leaving.has(email.id)) ??
      emails
        .slice(0, Math.max(index, 0))
        .reverse()
        .find((email) => !leaving.has(email.id));
    setSelectedId(next ? next.id : null);
  }

  // Applies an action to one or many messages. The local truth updates
  // before the network is touched, so every view is correct instantly.
  function performAction(ids: string[], action: MessageAction) {
    if (ids.length === 0) return;
    // Resolve each row's owning account up front, while the rows are still in
    // view (undo/chained actions can't re-derive it once they've left).
    let items: UndoItem[] = ids.map((id) => ({ id, account: accountOf(id) }));
    // In the unified view, never act on a row whose account we can't resolve —
    // a write with account:undefined would fall back to the active mailbox.
    if (account === "all") items = items.filter((p) => p.account !== undefined);
    if (items.length === 0) return;

    if (view !== "drafts" && LEAVES_FOLDER[folder].includes(action)) {
      advanceSelectionPast(items.map((p) => p.id));
    }
    applyLocal(items, action);

    // Read-state flips fire on every J/K; they never move a message, so
    // they stay untracked and trigger no reconciling refetch.
    const tracked = action !== "read" && action !== "unread";
    const callbacks = tracked ? trackedCallbacks : undefined;

    // One Gmail call per owning account, chunked to the server's per-call caps
    // (bulkModify 50 / bulkDelete 25) so a select-all over a big window doesn't
    // overflow the Zod limit. A multiselect can span mailboxes; each chunk is
    // tracked independently.
    const cap = action === "deleteForever" ? 25 : 50;
    for (const [acct, gids] of groupByPairs(items)) {
      for (let i = 0; i < gids.length; i += cap) {
        const slice = gids.slice(i, i + cap);
        if (tracked) inFlight.current += 1;
        if (action === "deleteForever") {
          if (slice.length === 1) {
            modifyMessage.mutate(
              { id: slice[0]!, account: acct, action },
              callbacks,
            );
          } else {
            bulkDelete.mutate({ ids: slice, account: acct }, callbacks);
          }
        } else if (slice.length === 1) {
          modifyMessage.mutate(
            { id: slice[0]!, account: acct, action },
            callbacks,
          );
        } else {
          bulkModify.mutate({ ids: slice, account: acct, action }, callbacks);
        }
      }
    }
    setBulkIds(new Set());

    if (action === "archive" || action === "unarchive" || action === "trash") {
      pushUndo({ items, action });
    }
  }

  // Reverses the last archive/trash: rows come back instantly, Gmail follows.
  function performUndo() {
    if (!undo) return;
    const reverse = UNDO_REVERSE[undo.action];
    applyLocal(undo.items, reverse);
    for (const [acct, gids] of groupByPairs(undo.items)) {
      for (let i = 0; i < gids.length; i += 50) {
        const slice = gids.slice(i, i + 50);
        inFlight.current += 1;
        if (slice.length === 1) {
          modifyMessage.mutate(
            { id: slice[0]!, account: acct, action: reverse },
            trackedCallbacks,
          );
        } else {
          bulkModify.mutate(
            { ids: slice, account: acct, action: reverse },
            trackedCallbacks,
          );
        }
      }
    }
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    setUndo(null);
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
    if (confirm.kind === "draft") {
      const draftId = confirm.ids[0];
      if (draftId) {
        if (selectedDraftId === draftId) setSelectedDraftId(null);
        deleteDraft.mutate({ draftId, account: draftAccountOf(draftId) });
      }
    } else {
      performAction(
        confirm.ids,
        confirm.kind === "trash" ? "trash" : "deleteForever",
      );
    }
    setConfirm(null);
  }

  // Roving selection for the drafts list.
  function moveDraftSelection(step: 1 | -1) {
    const list = drafts.data ?? [];
    if (list.length === 0) return;
    const index = list.findIndex((draft) => draft.id === selectedDraftId);
    const next =
      index === -1 ? 0 : Math.min(Math.max(index + step, 0), list.length - 1);
    const target = list[next];
    if (!target) return;
    setSelectedDraftId(target.id);
    document
      .querySelector(`[data-draft-id="${target.id}"]`)
      ?.scrollIntoView({ block: "nearest" });
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
      applyLocal([{ id: readId, account: accountOf(readId) }], "read");
      modifyMessage.mutate({ id: readId, account: accountOf(readId), action: "read" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readId, selectedEmail.data]);

  // ---- compose seeds ----------------------------------------------------------

  // Reply to the latest message in the thread (it carries the Message-ID
  // headers Gmail needs to nest the reply). replyAll cc's the other people.
  function startReply(replyAll = false) {
    const message = selectedEmail.data;
    if (!message) return;
    const last = threadMessages[threadMessages.length - 1];
    const replyToAddr = parseEmailAddress(
      (last?.from ?? message.from ?? "").split(",")[0] ?? "",
    ).email;
    if (!replyToAddr) return;
    setEditingDraftId(null);
    setTo(replyToAddr);

    if (replyAll) {
      const others = [
        ...(last?.to ?? message.to ?? "").split(","),
        ...(last?.cc ?? "").split(","),
      ]
        .map((entry) => parseEmailAddress(entry).email)
        .filter(
          (email) =>
            email &&
            email.toLowerCase() !== replyToAddr.toLowerCase() &&
            // Drop self. If the profile hasn't loaded yet, fall back to the
            // reply-to host so a same-domain self-address is still excluded.
            (myEmail ? email.toLowerCase() !== myEmail : true),
        );
      const unique = [...new Set(others)];
      if (unique.length > 0) {
        setCc(unique.join(", "));
        setShowCcBcc(true);
      }
    }

    const subj = last?.subject ?? message.subject ?? "";
    setSubject(/^re:/i.test(subj) ? subj : `Re: ${subj}`);
    setReplyThread({
      threadId: thread.data?.id ?? message.threadId ?? "",
      inReplyTo: last?.messageIdHeader ?? "",
      references: [last?.references, last?.messageIdHeader]
        .filter(Boolean)
        .join(" ")
        .trim(),
    });
    onComposeOpenChange(true);
  }

  function forwardSelection() {
    const message = selectedEmail.data;
    if (!message) return;
    setEditingDraftId(null);
    // A forward is a fresh message, not a threaded reply.
    setReplyThread(null);
    setCc("");
    setBcc("");
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
      const draft = await utils.gmail.getDraft.fetch({
        id: draftId,
        account: draftAccountOf(draftId),
      });
      setEditingDraftId(draftId);
      setTo(draft.to);
      setCc(draft.cc);
      setBcc(draft.bcc);
      if (draft.cc || draft.bcc) setShowCcBcc(true);
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
    const draftAccount = draftAccountOf(editingDraftId);
    await updateDraft.mutateAsync({
      ...composePayload(),
      draftId: editingDraftId,
      account: draftAccount,
    });
    await sendDraft.mutateAsync({ draftId: editingDraftId, account: draftAccount });
    closeCompose();
  }

  async function saveEditedDraft() {
    if (!editingDraftId) return;
    await updateDraft.mutateAsync({
      ...composePayload(),
      draftId: editingDraftId,
      account: draftAccountOf(editingDraftId),
    });
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
    // Pull more into view as the selection nears the end.
    if (next >= emails.length - 3) revealMore();
  }

  // Grow the window, then (once it's exhausted) deep-sync the cache for more.
  function revealMore() {
    if (!inMessages || isPriority) return;
    if (inbox.data?.hasMore) {
      // More rows already sit in the window — reveal them.
      if (limit < MAIL_WINDOW) {
        setLimit((l) => Math.min(l + MAIL_PAGE, MAIL_WINDOW));
      }
    } else if (
      // Whole window shown: deep-sync Gmail for older mail. syncMore pages the
      // general message stream, which backfills inbox, archive and starred
      // alike. (Spam/Trash sync on open; search has no deep-sync path.)
      (folder === "inbox" || folder === "archived" || folder === "starred") &&
      !activeSearch.trim() &&
      canSyncMore &&
      !syncMore.isPending
    ) {
      syncMore.mutate();
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
      // Select all loaded messages.
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "a" &&
        inMessages &&
        emails.length > 0
      ) {
        event.preventDefault();
        setBulkIds(new Set(emails.map((email) => email.id)));
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      // With a multiselect active, action keys apply to the selection.
      const targets =
        bulkIds.size > 0 ? [...bulkIds] : selectedId ? [selectedId] : [];

      switch (event.key) {
        case "j":
        case "ArrowDown":
          if (inMessages) moveSelection(1);
          else moveDraftSelection(1);
          break;
        case "k":
        case "ArrowUp":
          if (inMessages) moveSelection(-1);
          else moveDraftSelection(-1);
          break;
        case "Enter":
        case "o":
          if (inMessages) {
            if (emails.length === 0) return;
            if (!selectedId) setSelectedId(emails[0]?.id ?? null);
          } else {
            if (!selectedDraftId) return;
            void openDraft(selectedDraftId);
          }
          break;
        case " ": {
          // Space scrolls the open message; shift scrolls back up.
          const pane = readRef.current;
          if (!selectedId || !pane) return;
          pane.scrollBy({
            top: (event.shiftKey ? -1 : 1) * pane.clientHeight * 0.85,
            behavior: "smooth",
          });
          break;
        }
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
          if (!inMessages && selectedDraftId) {
            setSelectedDraftId(null);
            break;
          }
          if (!selectedId) return;
          setSelectedId(null);
          break;
        case "e":
          if (!inMessages || targets.length === 0) return;
          performAction(targets, E_ACTION[folder]);
          break;
        case "z":
          if (!undo) return;
          performUndo();
          break;
        case "#":
          if (inMessages) {
            if (targets.length === 0) return;
            if (folder === "spam" || folder === "trash") requestDelete(targets);
            else requestTrash(targets);
          } else {
            if (!selectedDraftId) return;
            setConfirm({ kind: "draft", ids: [selectedDraftId] });
          }
          break;
        case "s":
          if (!inMessages) return;
          if (bulkIds.size > 0) performAction(targets, "star");
          else toggleStar();
          break;
        case "U":
          if (!inMessages) return;
          if (bulkIds.size > 0) performAction(targets, "unread");
          else toggleUnread();
          break;
        case "r":
          if (!selectedId) return;
          startReply(false);
          break;
        case "R":
          if (!selectedId) return;
          startReply(true);
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
    if (folder === "spam" || folder === "trash" || folder === "sent") {
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
    setSelectedDraftId(null);
    if (view === "priority") triageRuns.current = 0;
  }, [view]);

  // Opening Priority kicks off classification of whatever is untriaged.
  useEffect(() => {
    if (!isPriority || overview.isLoading) return;
    if (pendingTriage > 0 && !triageRun.isPending && triageRuns.current === 0) {
      triageRuns.current = 1;
      triageRun.mutate();
    }
  }, [isPriority, overview.isLoading, pendingTriage, triageRun]);

  // Full sync cadence: once per page visit, then every 24 hours while the page
  // stays open. First connect is handled by the sync veil, so this stands down
  // during firstRun (autoSync is false then). The module-level `visitSynced`
  // flag means a mere view-switch remount doesn't re-sync — only a real page
  // load resets it. Between full syncs, syncNew's lightweight poll keeps new
  // mail flowing in.
  const fullSyncRef = useRef<() => void>(() => undefined);
  fullSyncRef.current = () => {
    if (autoSync && !refreshInbox.isPending) refreshInbox.mutate();
  };
  useEffect(() => {
    if (!autoSync) return;
    if (!visitSynced) {
      visitSynced = true;
      fullSyncRef.current();
    }
    const id = window.setInterval(
      () => fullSyncRef.current(),
      24 * 60 * 60 * 1000,
    );
    return () => window.clearInterval(id);
  }, [autoSync]);

  // Spam, trash and sent sync on first open when empty.
  const syncedFolders = useRef(new Set<string>());
  useEffect(() => {
    if (folder !== "spam" && folder !== "trash" && folder !== "sent") return;
    if (inbox.isLoading || emails.length > 0) return;
    if (syncedFolders.current.has(folder)) return;
    const target = folder;
    syncedFolders.current.add(target);
    // Drop the guard on failure so the folder re-syncs on its next open.
    syncFolder.mutate(
      { folder: target },
      { onError: () => syncedFolders.current.delete(target) },
    );
  }, [folder, inbox.isLoading, emails.length, syncFolder]);

  // Infinite scroll: reveal more of the stable list as the sentinel nears,
  // then deep-sync the cache (inbox only) once the window is exhausted.
  const revealMoreRef = useRef(revealMore);
  revealMoreRef.current = revealMore;
  // The sentinel only exists once rows render, so re-attach the observer when
  // the list first has rows — not just on mount, when it's still empty.
  const hasRows = inMessages && !isPriority && emails.length > 0;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) revealMoreRef.current();
      },
      { rootMargin: "300px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasRows]);

  const composeError =
    createDraft.error ?? sendEmail.error ?? updateDraft.error ?? sendDraft.error;
  const canSend = Boolean(to && subject && body);
  const composeBusy =
    sendEmail.isPending ||
    createDraft.isPending ||
    updateDraft.isPending ||
    sendDraft.isPending;
  const listBusy = searching
    ? smart.isLoading
    : inbox.isLoading || (syncFolder.isPending && emails.length === 0);
  const bulkList = [...bulkIds];

  // One row, shared by the folder lists and the grouped Priority view. In
  // Priority the snippet line carries the model's reason instead.
  const renderRow = (email: (typeof emails)[number], i: number) => {
    const chip = email.priority ? PRIORITY_CHIPS[email.priority] : undefined;
    const sub = isPriority && email.reason ? email.reason : email.snippet;
    return (
      <motion.div
        key={rowKey(email)}
        className="row"
        role="button"
        tabIndex={0}
        data-active={selectedId === email.id}
        data-unread={email.unread}
        data-checked={bulkIds.has(email.id)}
        data-mail-id={email.id}
        aria-current={selectedId === email.id || undefined}
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
          <button
            type="button"
            className="row-check"
            aria-pressed={bulkIds.has(email.id)}
            aria-label={
              bulkIds.has(email.id) ? "Deselect message" : "Select message"
            }
            data-checked={bulkIds.has(email.id)}
            onClick={(e) => {
              e.stopPropagation();
              toggleBulk(email.id);
            }}
          >
            <CheckIcon size={11} />
          </button>
        </span>
        <span className="row-inner">
          <span className="row-top">
            {email.unread && <span className="row-dot" />}
            <span className="row-from">
              {folder === "sent"
                ? senderLabel(email.to)
                : senderLabel(email.from)}
            </span>
            {account === "all" && multiAccount && email.accountId && (
              <span
                className="row-acct"
                style={{
                  background:
                    accountColor(email.accountId) ?? "var(--color-accent)",
                }}
                title={email.accountEmail}
              />
            )}
            {chip && (
              <span className="row-pri" data-pri={email.priority}>
                {chip}
              </span>
            )}
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
          {sub && <span className="row-snippet">{sub}</span>}
        </span>
      </motion.div>
    );
  };

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
              searchRef.current?.blur();
            }}
          >
            {inMessages && !isPriority ? (
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
              <span className="mail-search-label">
                {isPriority ? "Priority" : "Drafts"}
              </span>
            )}
            <button
              type="button"
              className="icon-btn"
              data-tip="Refresh from Gmail"
              data-tip-pos="down"
              aria-label="Refresh from Gmail"
              data-spinning={refreshInbox.isPending || syncFolder.isPending}
              onClick={() =>
                folder === "spam" || folder === "trash" || folder === "sent"
                  ? syncFolder.mutate({ folder })
                  : refreshInbox.mutate()
              }
              disabled={refreshInbox.isPending || syncFolder.isPending}
            >
              <RefreshIcon size={15} />
            </button>
          </form>
        )}

        {operatorChips.length > 0 && (
          <div className="search-chips" role="note">
            <span className="search-chips-label">Corsair filter</span>
            {operatorChips.map((chip) => (
              <span key={chip.key} className="search-chip">
                {chip.label}
              </span>
            ))}
          </div>
        )}

        <div className="mail-rows" data-bulk={bulkIds.size > 0}>
          {inMessages && !isPriority && listBusy && (
            <SyncingState label="Syncing…" />
          )}
          {inMessages &&
            !isPriority &&
            !listBusy &&
            !inbox.error &&
            refreshInbox.isPending &&
            emails.length > 0 && (
              <div className="syncing-bar tnum" role="status">
                Syncing…
              </div>
            )}
          {inMessages && !isPriority && inbox.error && (
            <p className="error" style={{ padding: "0.5rem 0.6rem" }}>
              {inbox.error.message}
            </p>
          )}
          {inMessages &&
            !isPriority &&
            !listBusy &&
            !inbox.error &&
            (emails.length === 0 ? (
              searching ? (
                <p className="muted" style={{ padding: "0.5rem 0.6rem" }}>
                  No matches for “{activeSearch.trim()}”.
                </p>
              ) : refreshInbox.isPending ? (
                <MailRowsSkeleton />
              ) : (
                <p className="muted" style={{ padding: "0.5rem 0.6rem" }}>
                  {EMPTY_COPY[folder]}
                </p>
              )
            ) : (
              <>
                {emails.map(renderRow)}
                {(syncMore.isPending ||
                  (inbox.isFetching && inbox.isPlaceholderData)) && (
                  <MailRowsSkeleton count={3} />
                )}
                <div ref={sentinelRef} aria-hidden="true" style={{ height: 1 }} />
              </>
            ))}

          {isPriority && (
            <>
              {/* Slim banner only when rows already show beneath it. */}
              {(triageRun.isPending || refreshInbox.isPending) &&
                emails.length > 0 && (
                  <p className="pri-banner tnum" role="status">
                    {refreshInbox.isPending
                      ? "Refreshing from Gmail…"
                      : `Classifying ${pendingTriage > 0 ? pendingTriage : "new"} messages…`}
                  </p>
                )}
              {overview.error ? (
                <p className="error" style={{ padding: "0.5rem 0.6rem" }}>
                  {overview.error.message}
                </p>
              ) : triageRun.error ? (
                <p className="error" style={{ padding: "0.5rem 0.6rem" }}>
                  {triageRun.error.message}
                </p>
              ) : overview.isLoading ||
                (emails.length === 0 &&
                  (triageRun.isPending || refreshInbox.isPending)) ? (
                <SyncingState
                  label={
                    refreshInbox.isPending
                      ? "Syncing…"
                      : overview.isLoading
                        ? "Syncing…"
                        : `Classifying ${pendingTriage > 0 ? pendingTriage : "new"} messages…`
                  }
                />
              ) : emails.length === 0 ? (
                <p className="muted" style={{ padding: "0.5rem 0.6rem" }}>
                  Nothing to triage. Inbox mail is classified automatically when
                  you open Priority.
                </p>
              ) : (
                (() => {
                    let index = -1;
                    return PRIORITY_ORDER.map((priority) => {
                      const group = emails.filter(
                        (email) => email.priority === priority,
                      );
                      if (group.length === 0) return null;
                      return (
                        <div className="pri-group" key={priority}>
                          <div className="pri-head" data-pri={priority}>
                            {PRIORITY_LABELS[priority]}
                            <span className="pri-count tnum">
                              {group.length}
                            </span>
                          </div>
                          {group.map((email) => {
                            index += 1;
                            return renderRow(email, index);
                          })}
                        </div>
                      );
                    });
                  })()
                )}
            </>
          )}

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
                <div
                  key={draft.id}
                  className="draft-row"
                  data-active={selectedDraftId === draft.id}
                  data-draft-id={draft.id}
                >
                  <button
                    type="button"
                    className="draft-main"
                    onClick={() => {
                      setSelectedDraftId(draft.id);
                      void openDraft(draft.id);
                    }}
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
                    onClick={() =>
                      sendDraft.mutate({
                        draftId: draft.id,
                        account: draft.accountId,
                      })
                    }
                    disabled={sendDraft.isPending}
                  >
                    Send
                  </button>
                  <button
                    type="button"
                    className="link draft-delete"
                    onClick={() =>
                      confirmDeleteId === draft.id
                        ? deleteDraft.mutate({
                            draftId: draft.id,
                            account: draft.accountId,
                          })
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

      <section className="mail-read" ref={readRef}>
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
                    onClick={() => startReply(false)}
                  >
                    <ReplyIcon size={16} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    data-tip="Reply all — ⇧R"
                    data-tip-pos="down"
                    aria-label="Reply all"
                    onClick={() => startReply(true)}
                  >
                    <ReplyAllIcon size={16} />
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
            {isThread ? (
              <>
                <p className="thread-count tnum">
                  {threadMessages.length} messages in this conversation
                </p>
                <ThreadView
                  key={`${thread.data?.id ?? "t"}-${selectedEmail.data.id}`}
                  messages={threadMessages}
                  focusId={selectedEmail.data.id}
                />
              </>
            ) : (
              <>
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
              </>
            )}
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
              ref={confirmRef}
              className="confirm"
              variants={slideOver}
              initial="initial"
              animate="animate"
              exit="exit"
              role="alertdialog"
              aria-modal="true"
              aria-label="Confirm action"
            >
              <div className="confirm-body">
                <h2 className="confirm-title">
                  {confirm.kind === "trash"
                    ? `Move ${confirm.ids.length === 1 ? "this message" : `${confirm.ids.length} messages`} to trash?`
                    : confirm.kind === "draft"
                      ? "Delete this draft?"
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
                  {confirm.kind === "trash"
                    ? "Move to trash"
                    : confirm.kind === "draft"
                      ? "Delete draft"
                      : "Delete forever"}
                  <Kbd>↵</Kbd>
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {undo && (
          <motion.div
            className="undo-toast"
            variants={chordBar}
            initial="initial"
            animate="animate"
            exit="exit"
            role="status"
          >
            <span className="tnum">{undoLabel(undo)}</span>
            <button type="button" className="btn" onClick={performUndo}>
              Undo
              <Kbd>Z</Kbd>
            </button>
          </motion.div>
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
              ref={composeRef}
              className="compose"
              variants={slideOver}
              initial="initial"
              animate="animate"
              exit="exit"
              role="dialog"
              aria-modal="true"
              aria-label="Compose message"
              onKeyDown={(event) => {
                if (!(event.metaKey || event.ctrlKey)) return;
                if (event.key === "Enter" && canSend && !composeBusy) {
                  event.preventDefault();
                  if (editingDraftId) void sendEditedDraft();
                  else sendEmail.mutate(composePayload());
                } else if (
                  event.key.toLowerCase() === "s" &&
                  canSend &&
                  !composeBusy
                ) {
                  event.preventDefault();
                  if (editingDraftId) void saveEditedDraft();
                  else createDraft.mutate(composePayload());
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
                <div className="compose-recip">
                  <input
                    ref={toRef}
                    className="field"
                    type="email"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    placeholder="To"
                  />
                  {!showCcBcc && (
                    <button
                      type="button"
                      className="link compose-ccbcc-toggle"
                      onClick={() => setShowCcBcc(true)}
                    >
                      Cc / Bcc
                    </button>
                  )}
                </div>
                {showCcBcc && (
                  <>
                    <input
                      className="field"
                      type="text"
                      value={cc}
                      onChange={(e) => setCc(e.target.value)}
                      placeholder="Cc (comma-separated)"
                    />
                    <input
                      className="field"
                      type="text"
                      value={bcc}
                      onChange={(e) => setBcc(e.target.value)}
                      placeholder="Bcc (comma-separated)"
                    />
                  </>
                )}
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
                      : sendEmail.mutate(composePayload())
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
                      : createDraft.mutate(composePayload())
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

type ThreadMessage = {
  id: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string | null;
  snippet: string;
  body: string;
  html: string;
  unread: boolean;
};

/**
 * A conversation: every message stacked oldest-first. The focused (clicked)
 * message and the latest one open by default; the rest collapse to a one-line
 * summary you can expand.
 */
function ThreadView({
  messages,
  focusId,
}: {
  messages: ThreadMessage[];
  focusId: string;
}) {
  const lastId = messages[messages.length - 1]?.id;
  const [open, setOpen] = useState<Set<string>>(
    () => new Set([focusId, lastId].filter(Boolean) as string[]),
  );
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="thread">
      {messages.map((message) => {
        const isOpen = open.has(message.id);
        return (
          <div
            className="thread-msg"
            data-open={isOpen}
            data-unread={message.unread}
            key={message.id}
          >
            <button
              type="button"
              className="thread-msg-head"
              onClick={() => toggle(message.id)}
            >
              <span className="thread-from">{senderLabel(message.from)}</span>
              {!isOpen && (
                <span className="thread-preview">{message.snippet}</span>
              )}
              {message.date && (
                <span className="thread-date tnum">
                  {formatMessageDate(message.date)}
                </span>
              )}
            </button>
            {isOpen && (
              <div className="thread-msg-body">
                <div className="thread-meta tnum">
                  <span>To: {message.to || "—"}</span>
                  {message.cc && <span>Cc: {message.cc}</span>}
                </div>
                <EmailBody
                  key={message.id}
                  html={message.html}
                  text={message.body || message.snippet}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
