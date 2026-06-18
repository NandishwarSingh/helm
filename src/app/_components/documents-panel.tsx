"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";

import {
  CloseIcon,
  DocumentsIcon,
  DownloadIcon,
  PinIcon,
  RefreshIcon,
  SearchIcon,
} from "@/components/icons";
import { HelmLoader } from "@/components/helm-loader";
import { Kbd } from "@/components/kbd";
import { hasOverlay, isTypingTarget, useAction, useOverlay } from "@/lib/actions";
import { formatAccountEmail } from "@/lib/display";
import { drawerRight, listRow, scrim, snap, snapFast, viewSwap } from "@/lib/motion";
import { useFocusTrap } from "@/lib/use-focus-trap";
import { api, type RouterOutputs } from "@/trpc/react";

type DocItem = RouterOutputs["documents"]["list"]["items"][number];
type Category =
  | "all"
  | "pdf"
  | "image"
  | "doc"
  | "sheet"
  | "slide"
  | "archive"
  | "audio"
  | "video"
  | "other";

const CATEGORY_LABEL: Record<string, string> = {
  all: "All",
  pdf: "PDFs",
  image: "Images",
  doc: "Docs",
  sheet: "Sheets",
  slide: "Slides",
  archive: "Archives",
  audio: "Audio",
  video: "Video",
  other: "Other",
};
// Canonical chip order; only categories Google actually returned are shown.
const CATEGORY_ORDER = [
  "pdf",
  "image",
  "doc",
  "sheet",
  "slide",
  "archive",
  "audio",
  "video",
  "other",
] as const;
const SYNC_TIMEOUT_MS = 120_000;
const PAGE_SIZE = 60;
const MAX_LIMIT = 300;
const LOAD_MORE_MIN_MS = 650;
// Re-opening Documents within this window skips the cheap auto-sync (the realtime
// SSE already keeps it fresh) — a deep/new-account scan always bypasses it.
const AUTO_SCAN_THROTTLE_MS = 20_000;

// Module-level so a sync — and its indicator — survives this panel unmounting
// when you switch views (the scan itself runs server-side regardless). Keyed by
// the `account` scope prop ("all" or an account id).
const deepScannedScopes = new Set<string>(); // scopes given their first deep scan
const knownAccountIds = new Set<string>(); // every account id seen this session
const lastAutoScanAt = new Map<string, number>(); // throttle the cheap auto-sync
const syncStartedAt = new Map<string, number>(); // scope -> sync start ms (bg overlay)

type GroupBy = "type" | "sender" | "date";

function fmtBytes(n: number): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(value: Date | string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(
    "en-US",
    sameYear
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" },
  );
}

function dateBucket(value: Date | string | null): string {
  if (!value) return "Undated";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Undated";
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfDoc = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
  const days = Math.round((startOfToday - startOfDoc) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This week";
  if (days < 30) return "This month";
  return "Older";
}

const DATE_BUCKET_RANK: Record<string, number> = {
  Today: 0,
  Yesterday: 1,
  "This week": 2,
  "This month": 3,
  Older: 4,
  Undated: 5,
};

type Group = { key: string; label: string; docs: DocItem[] };

/** Pinned items always lead in their own group; the rest group by the toggle. */
function groupDocs(items: DocItem[], groupBy: GroupBy): Group[] {
  const pinned = items.filter((d) => d.pinned);
  const rest = items.filter((d) => !d.pinned);
  const groups = new Map<string, Group>();
  for (const doc of rest) {
    let key: string;
    let label: string;
    if (groupBy === "type") {
      key = doc.category;
      label = CATEGORY_LABEL[doc.category] ?? "Other";
    } else if (groupBy === "sender") {
      const sender = doc.sender?.trim() ?? "";
      key = sender.toLowerCase() || "unknown";
      label = sender || "Unknown sender";
    } else {
      label = dateBucket(doc.receivedAt);
      key = label;
    }
    const existing = groups.get(key);
    if (existing) existing.docs.push(doc);
    else groups.set(key, { key, label, docs: [doc] });
  }
  const ordered = [...groups.values()];
  if (groupBy === "date") {
    ordered.sort(
      (a, b) => (DATE_BUCKET_RANK[a.label] ?? 9) - (DATE_BUCKET_RANK[b.label] ?? 9),
    );
  } else if (groupBy === "type") {
    const order = CATEGORY_ORDER as readonly string[];
    ordered.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  } else {
    ordered.sort((a, b) => b.docs.length - a.docs.length);
  }
  return pinned.length > 0
    ? [{ key: "__pinned", label: "Pinned", docs: pinned }, ...ordered]
    : ordered;
}

/** Stable key for an attachment across accounts (mirrors the server rowKey). */
function docKey(d: DocItem): string {
  return `${d.accountId}:${d.messageId}:${d.attachmentId}`;
}

function previewUrl(d: DocItem, disposition: "inline" | "attachment"): string {
  const qs = new URLSearchParams({
    account: d.accountId,
    disposition,
  });
  return `/api/documents/${encodeURIComponent(d.messageId)}/${encodeURIComponent(
    d.attachmentId,
  )}?${qs.toString()}`;
}

function previewKind(d: DocItem | null): "pdf" | "image" | "none" {
  if (!d) return "none";
  if (d.category === "pdf" || d.mimeType === "application/pdf") return "pdf";
  if (d.category === "image") return "image";
  return "none";
}

export function DocumentsPanel({ account }: { account: string }) {
  const utils = api.useUtils();
  const [groupBy, setGroupBy] = useState<GroupBy>("type");
  const [category, setCategory] = useState<Category>("all");
  const [limits, setLimits] = useState<Partial<Record<Category, number>>>({
    all: PAGE_SIZE,
  });
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [preview, setPreview] = useState<DocItem | null>(null);
  // Restore the syncing indicator if a scan started in another mount of this
  // scope is still in its window — so the overlay survives a view switch.
  const [syncing, setSyncing] = useState(() => {
    const started = syncStartedAt.get(account);
    return started !== undefined && Date.now() - started < SYNC_TIMEOUT_MS;
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const [activeDocKey, setActiveDocKey] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const syncTimeoutRef = useRef<number | null>(null);
  const loadMoreStartedRef = useRef(0);
  const previewWarmRef = useRef<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const limit = limits[category] ?? PAGE_SIZE;

  // Suppress the app's global key layer (1/2/3/4, g-chord, ⌘J, c, n, /) while a
  // preview is open, so a stray key can't switch views and unmount the preview.
  // The drawer keeps its own Esc handler. (Account-scope changes reset all state
  // via the key={activeAccount} remount in AppShell — no reset effect needed.)
  useOverlay(preview !== null);

  // Debounce the search box → the vector query only fires when typing settles.
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query.trim()), 300);
    return () => window.clearTimeout(id);
  }, [query]);

  const searching = debounced.length > 0;

  const accountsQuery = api.accounts.list.useQuery(undefined, {
    staleTime: 30_000,
  });
  const accountList = accountsQuery.data?.accounts ?? [];
  const multiAccount = accountsQuery.data?.multi ?? false;
  const accountColor = (id: string): string =>
    accountList.find((a) => a.id === id)?.color ?? "var(--color-accent)";

  const facetsQuery = api.documents.facets.useQuery(
    { account },
    {
      staleTime: 15_000,
      refetchInterval: () =>
        document.visibilityState === "visible" ? 30_000 : false,
    },
  );

  const facetCounts = facetsQuery.data?.counts;
  const facetTotal = facetsQuery.data?.total ?? 0;
  const visibleCategories = useMemo(
    () => CATEGORY_ORDER.filter((c) => (facetCounts?.[c] ?? 0) > 0),
    [facetCounts],
  );
  const categoryTabs = useMemo<Category[]>(
    () => ["all", ...visibleCategories],
    [visibleCategories],
  );

  const listInput = { category, account, limit };
  const listQuery = api.documents.list.useQuery(listInput, {
    enabled: !searching,
    placeholderData: loadingMore ? keepPreviousData : undefined,
    staleTime: 60_000,
    refetchInterval: () => (document.visibilityState === "visible" ? 30_000 : false),
  });

  const searchQuery = api.documents.vectorSearch.useQuery(
    { query: debounced, account, category, limit: 40 },
    { enabled: searching, placeholderData: keepPreviousData },
  );

  const setPin = api.documents.setPin.useMutation({
    onMutate: async (vars) => {
      // Capture the exact query key written at mutate-time; the user may switch
      // category/limit before settle, so onError must roll back THIS key, not the
      // live listInput (which would reflect a later render).
      const input = { category, account, limit };
      await utils.documents.list.cancel(input);
      const prev = utils.documents.list.getData(input);
      utils.documents.list.setData(input, (old) => {
        if (!old) return old;
        const items = old.items.map((it) =>
          it.accountId === vars.account &&
          it.messageId === vars.messageId &&
          it.attachmentId === vars.attachmentId
            ? { ...it, pinned: vars.pinned, pinnedAt: vars.pinned ? new Date() : null }
            : it,
        );
        // Re-establish pinned-first, then pinnedAt, then receivedAt (server order).
        const rank = (it: DocItem): [number, number, number] => [
          it.pinned ? 1 : 0,
          it.pinnedAt ? new Date(it.pinnedAt).getTime() : 0,
          it.receivedAt ? new Date(it.receivedAt).getTime() : 0,
        ];
        items.sort((a, b) => {
          const ra = rank(a);
          const rb = rank(b);
          return rb[0] - ra[0] || rb[1] - ra[1] || rb[2] - ra[2];
        });
        return { ...old, items };
      });
      return { prev, input };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev) utils.documents.list.setData(ctx.input, ctx.prev);
    },
    onSettled: () => {
      // Invalidate BOTH caches: in search mode the visible rows come from
      // vectorSearch, so the pin button would otherwise stay stale until refetch.
      void utils.documents.list.invalidate();
      void utils.documents.vectorSearch.invalidate();
    },
  });

  const scan = api.documents.scan.useMutation({
    onSuccess: () => {
      void utils.documents.list.invalidate();
      void utils.documents.facets.invalidate();
    },
  });

  useEffect(() => {
    if (searching || visibleCategories.length === 0) return;
    for (const c of categoryTabs) {
      if (c === category) continue;
      void utils.documents.list.prefetch({
        category: c,
        account,
        limit: limits[c] ?? PAGE_SIZE,
      });
    }
  }, [
    account,
    category,
    categoryTabs,
    limits,
    searching,
    utils.documents.list,
    visibleCategories.length,
  ]);

  useEffect(() => {
    if (!loadingMore || listQuery.isFetching) return;
    const elapsed = performance.now() - loadMoreStartedRef.current;
    const remaining = Math.max(0, LOAD_MORE_MIN_MS - elapsed);
    const timeout = window.setTimeout(() => setLoadingMore(false), remaining);
    return () => window.clearTimeout(timeout);
  }, [listQuery.isFetching, loadingMore]);

  function clearSyncTimeout() {
    if (syncTimeoutRef.current === null) return;
    window.clearTimeout(syncTimeoutRef.current);
    syncTimeoutRef.current = null;
  }

  const finishSyncRef = useRef(() => undefined as void);
  finishSyncRef.current = () => {
    clearSyncTimeout();
    syncStartedAt.delete(account);
    setSyncing(false);
    refreshRef.current();
  };

  function startScan(opts: { deep?: boolean } = {}) {
    if (scan.isPending || syncing) return;
    setSyncing(true);
    syncStartedAt.set(account, Date.now());
    clearSyncTimeout();
    scan.mutate(
      { deep: opts.deep ?? true },
      {
        onSuccess: () => {
          syncTimeoutRef.current = window.setTimeout(
            () => finishSyncRef.current(),
            SYNC_TIMEOUT_MS,
          );
        },
        onError: () => {
          clearSyncTimeout();
          syncStartedAt.delete(account);
          setSyncing(false);
        },
      },
    );
  }

  useEffect(
    () => () => {
      clearSyncTimeout();
    },
    [],
  );

  // Background-sync restore: if a scan for this scope is still in its window
  // (started in a prior mount), re-arm the completion timeout for the remainder.
  useEffect(() => {
    const started = syncStartedAt.get(account);
    if (started === undefined) return;
    const remaining = SYNC_TIMEOUT_MS - (Date.now() - started);
    if (remaining <= 0) {
      finishSyncRef.current();
      return;
    }
    clearSyncTimeout();
    syncTimeoutRef.current = window.setTimeout(
      () => finishSyncRef.current(),
      remaining,
    );
    return () => clearSyncTimeout();
  }, [account]);

  // Sync on open: a deep scan the first time a scope (or a newly-appeared
  // account) is opened so older attachments get indexed; a cheap incremental
  // scan (throttled) on routine re-opens — only genuinely-new attachments cost
  // work server-side. startScan no-ops while a sync is already running.
  const accountSig =
    account === "all"
      ? accountList
          .map((a) => a.id)
          .sort()
          .join(",")
      : account;
  useEffect(() => {
    const ids = account === "all" ? accountList.map((a) => a.id) : [account];
    const newAccount = ids.some((id) => id && !knownAccountIds.has(id));
    ids.forEach((id) => id && knownAccountIds.add(id));
    const deep = !deepScannedScopes.has(account) || newAccount;
    const last = lastAutoScanAt.get(account) ?? 0;
    if (!deep && Date.now() - last < AUTO_SCAN_THROTTLE_MS) return;
    deepScannedScopes.add(account);
    lastAutoScanAt.set(account, Date.now());
    startScan({ deep });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, accountSig]);

  // Keep the live-refresh handlers current without re-subscribing the SSE.
  const refreshRef = useRef(() => undefined as void);
  refreshRef.current = () => {
    void utils.documents.list.invalidate();
    void utils.documents.facets.invalidate();
    if (searching) void utils.documents.vectorSearch.invalidate();
  };
  // Realtime: a webhook sync indexes new attachments and notifies "documents"
  // (and "mail" carries possibly-attachment-bearing new mail). Refetch on either.
  useEffect(() => {
    if (typeof window === "undefined" || !("EventSource" in window)) return;
    const source = new EventSource("/api/stream");
    source.addEventListener("changed", (event) => {
      const kind = (event as MessageEvent<string>).data;
      if (kind === "documents") finishSyncRef.current();
      else if (kind === "mail") refreshRef.current();
    });
    return () => source.close();
  }, []);

  // Palette / global shortcuts: "/" focuses search, Refresh triggers a scan.
  useAction("focus-search", () => searchRef.current?.focus());
  useAction("refresh", () => {
    startScan();
  });

  function togglePin(doc: DocItem) {
    setPin.mutate({
      messageId: doc.messageId,
      attachmentId: doc.attachmentId,
      account: doc.accountId,
      pinned: !doc.pinned,
    });
  }

  function changeCategory(next: Category) {
    if (next === category) return;
    setLoadingMore(false);
    setCategory(next);
  }

  function stepCategory(delta: number) {
    const index = categoryTabs.indexOf(category);
    if (index === -1) return;
    const next = categoryTabs[(index + delta + categoryTabs.length) % categoryTabs.length];
    if (next) changeCategory(next);
  }

  function loadMore() {
    if (
      loadingMore ||
      !hasMore ||
      (limits[category] ?? PAGE_SIZE) >= MAX_LIMIT
    )
      return;
    loadMoreStartedRef.current = performance.now();
    setLoadingMore(true);
    setLimits((prev) => ({
      ...prev,
      [category]: Math.min((prev[category] ?? PAGE_SIZE) + PAGE_SIZE, MAX_LIMIT),
    }));
  }
  // Always call the freshest loadMore from the (mount-stable) observer below.
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;

  // Infinite scroll: a sentinel near the bottom of the scroller auto-loads the
  // next page. loadMore() guards on hasMore + the window cap, so this is a no-op
  // once everything's loaded; the Load more button stays as an explicit control.
  useEffect(() => {
    const root = scrollRef.current;
    const target = sentinelRef.current;
    if (!root || !target || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMoreRef.current();
      },
      { root, rootMargin: "320px 0px" },
    );
    io.observe(target);
    return () => io.disconnect();
  }, []);

  function triggerDownload(doc: DocItem) {
    const a = document.createElement("a");
    a.href = previewUrl(doc, "attachment");
    a.download = doc.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function warmPreview(doc: DocItem) {
    const kind = previewKind(doc);
    if (kind === "none") return;
    const key = docKey(doc);
    if (previewWarmRef.current.has(key)) return;
    previewWarmRef.current.add(key);
    const url = previewUrl(doc, "inline");
    if (kind === "image") {
      const image = new Image();
      image.decoding = "async";
      image.src = url;
      return;
    }
    void fetch(url, { credentials: "include" }).catch(() => {
      previewWarmRef.current.delete(key);
    });
  }

  const listItems = listQuery.data?.items;
  const searchItems = searchQuery.data?.items;
  const items = useMemo(
    () => (searching ? (searchItems ?? []) : (listItems ?? [])),
    [searching, searchItems, listItems],
  );
  const groups = useMemo(
    () =>
      searching
        ? [{ key: "__results", label: "Results", docs: items }]
        : groupDocs(items, groupBy),
    [items, groupBy, searching],
  );
  const visibleDocs = useMemo(() => groups.flatMap((group) => group.docs), [groups]);
  const activeDoc = useMemo(
    () => visibleDocs.find((doc) => docKey(doc) === activeDocKey) ?? null,
    [activeDocKey, visibleDocs],
  );
  const hasMore = !searching && (listQuery.data?.hasMore ?? false);
  const canLoadMore = hasMore && limit < MAX_LIMIT;
  const loading =
    (searching ? searchQuery.isLoading : listQuery.isLoading) &&
    items.length === 0;
  const empty = !loading && items.length === 0;

  useEffect(() => {
    if (visibleDocs.length === 0) {
      setActiveDocKey(null);
      return;
    }
    if (!activeDocKey || !visibleDocs.some((doc) => docKey(doc) === activeDocKey)) {
      setActiveDocKey(docKey(visibleDocs[0]!));
    }
  }, [activeDocKey, visibleDocs]);

  function selectDocAt(delta: number) {
    if (visibleDocs.length === 0) return;
    const current = activeDocKey
      ? visibleDocs.findIndex((doc) => docKey(doc) === activeDocKey)
      : -1;
    const nextIndex =
      current === -1
        ? delta > 0
          ? 0
          : visibleDocs.length - 1
        : Math.max(0, Math.min(visibleDocs.length - 1, current + delta));
    const next = visibleDocs[nextIndex];
    if (!next) return;
    const key = docKey(next);
    setActiveDocKey(key);
    window.requestAnimationFrame(() => {
      document
        .querySelector(`[data-doc-key="${CSS.escape(key)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (isTypingTarget(event.target) || hasOverlay()) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        selectDocAt(1);
      } else if (key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        selectDocAt(-1);
      } else if (key === "enter" || key === "o") {
        if (!activeDoc) return;
        event.preventDefault();
        setPreview(activeDoc);
      } else if (key === "p") {
        if (!activeDoc) return;
        event.preventDefault();
        togglePin(activeDoc);
      } else if (key === "d") {
        if (!activeDoc) return;
        event.preventDefault();
        triggerDownload(activeDoc);
      } else if (key === "h") {
        event.preventDefault();
        stepCategory(-1);
      } else if (key === "l") {
        event.preventDefault();
        stepCategory(1);
      } else if (key === "m") {
        event.preventDefault();
        loadMore();
      } else if (key === "r") {
        event.preventDefault();
        startScan();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <motion.div
      className="docs"
      variants={viewSwap}
      initial="initial"
      animate="animate"
    >
      <div className="docs-toolbar">
        <div className="docs-search">
          <SearchIcon size={15} />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search documents…"
            aria-label="Search documents"
            spellCheck={false}
          />
          {query && (
            <button
              type="button"
              className="icon-btn"
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
              aria-label="Clear search"
            >
              <CloseIcon size={14} />
            </button>
          )}
          {!query && <Kbd>/</Kbd>}
        </div>
        <div className="seg" role="group" aria-label="Group by">
          {(["type", "sender", "date"] as const).map((g) => (
            <button
              key={g}
              type="button"
              data-active={groupBy === g}
              onClick={() => setGroupBy(g)}
              disabled={searching}
            >
              {g === "type" ? "Type" : g === "sender" ? "Sender" : "Date"}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={() => startScan()}
          data-spinning={scan.isPending || syncing}
          disabled={scan.isPending || syncing}
          aria-label="Scan for new documents"
          title="Scan mail for new attachments — R"
          data-tip="Scan attachments — R"
          data-tip-pos="down"
        >
          <RefreshIcon size={16} />
        </button>
      </div>

      <div className="docs-chips" role="group" aria-label="Filter by type">
        <span className="docs-chip-keys" aria-label="Previous and next type filter">
          <Kbd>H</Kbd>
          <Kbd>L</Kbd>
        </span>
        <button
          type="button"
          className="docs-chip"
          data-active={category === "all"}
          onClick={() => changeCategory("all")}
        >
          All
          {facetTotal > 0 && <span className="docs-chip-n">{facetTotal}</span>}
        </button>
        {visibleCategories.map((c) => (
          <button
            key={c}
            type="button"
            className="docs-chip"
            data-active={category === c}
            onClick={() => changeCategory(c)}
          >
            {CATEGORY_LABEL[c]}
            <span className="docs-chip-n">{facetCounts?.[c] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="docs-scroll" ref={scrollRef}>
        {loading && (
          <div className="empty">
            <HelmLoader size={36} />
          </div>
        )}

        {empty && (
          <div className="empty docs-empty">
            <DocumentsIcon size={28} />
            <p>
              {searching
                ? "No documents match that search."
                : category !== "all"
                  ? "No documents of this type yet."
                  : "No documents yet. Attachments from your mail land here."}
            </p>
            {!searching && (
              <button
                type="button"
                className="btn"
                onClick={() => startScan()}
                disabled={scan.isPending || syncing}
              >
                {scan.isPending || syncing ? "Scanning…" : "Scan now"}
              </button>
            )}
          </div>
        )}

        {!loading &&
          groups.map((group) => (
            <section key={group.key} className="docs-group">
              <header className="docs-group-head">
                <span className="docs-group-title">
                  {group.key === "__pinned" && <PinIcon size={13} />}
                  <span>{group.label}</span>
                  <span className="docs-group-n">{group.docs.length}</span>
                </span>
                {group.key === groups[0]?.key && (
                  <span className="docs-row-keys" aria-label="Document shortcuts">
                    <Kbd>J</Kbd>
                    <Kbd>K</Kbd>
                    <Kbd>↵</Kbd>
                  </span>
                )}
              </header>
              <ul className="docs-rows">
                {group.docs.map((doc, i) => (
                  <motion.li
                    key={docKey(doc)}
                    className="docs-row"
                    data-pinned={doc.pinned}
                    data-selected={docKey(doc) === activeDocKey}
                    data-doc-key={docKey(doc)}
                    variants={listRow}
                    initial="initial"
                    animate="animate"
                    custom={i}
                  >
                    {/* Primary action is a real button so the row is operable by
                        keyboard; pin/download are siblings, never nested in it. */}
                    <button
                      type="button"
                      className="docs-row-open"
                      onFocus={() => setActiveDocKey(docKey(doc))}
                      onPointerEnter={() => warmPreview(doc)}
                      onClick={() => setPreview(doc)}
                    >
                      <span className="docs-row-icon">
                        <DocumentsIcon size={15} />
                      </span>
                      <span className="docs-row-main">
                        <span className="docs-row-name" title={doc.filename}>
                          {doc.filename}
                        </span>
                        <span className="docs-row-sub">
                          <span className="docs-row-from">
                            {doc.sender || "Unknown sender"}
                          </span>
                          {doc.subject && (
                            <span className="docs-row-subject">
                              {" · "}
                              {doc.subject}
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="docs-row-meta">
                        {account === "all" && multiAccount && (
                          <span
                            className="row-acct"
                            style={{ background: accountColor(doc.accountId) }}
                            title={formatAccountEmail(doc.accountEmail)}
                          />
                        )}
                        {doc.sizeBytes > 0 && (
                          <span className="docs-row-size">
                            {fmtBytes(doc.sizeBytes)}
                          </span>
                        )}
                        <span className="docs-row-date">
                          {fmtDate(doc.receivedAt)}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="icon-btn docs-row-act"
                      data-on={doc.pinned}
                      onClick={() => togglePin(doc)}
                      aria-label={doc.pinned ? "Unpin" : "Pin to top"}
                      aria-pressed={doc.pinned}
                      title={doc.pinned ? "Unpin — P" : "Pin to top — P"}
                      data-tip={doc.pinned ? "Unpin — P" : "Pin — P"}
                      data-tip-pos="down"
                    >
                      <PinIcon size={15} filled={doc.pinned} />
                    </button>
                    <a
                      className="icon-btn docs-row-act"
                      href={previewUrl(doc, "attachment")}
                      aria-label={`Download ${doc.filename}`}
                      title="Download — D"
                      data-tip="Download — D"
                      data-tip-pos="down"
                    >
                      <DownloadIcon size={15} />
                    </a>
                  </motion.li>
                ))}
              </ul>
            </section>
          ))}

        {/* Sentinel for infinite scroll — always rendered so the observer binds
            on mount; loadMore() self-guards on hasMore + the window cap. */}
        <div ref={sentinelRef} className="docs-sentinel" aria-hidden="true" />

        {canLoadMore && (
          <div className="docs-more">
            <LoadMoreButton loading={loadingMore} onClick={loadMore} />
          </div>
        )}
      </div>

      <SyncOverlay open={syncing} />

      <DocPreview doc={preview} onClose={() => setPreview(null)} />
    </motion.div>
  );
}

function SyncOverlay({ open }: { open: boolean }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="docs-sync-overlay"
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, x: "-50%", y: 12, scale: 0.96 }}
          animate={{ opacity: 1, x: "-50%", y: 0, scale: 1 }}
          exit={{ opacity: 0, x: "-50%", y: 12, scale: 0.96 }}
          transition={snap}
        >
          <motion.svg
            className="docs-sync-overlay-spin"
            viewBox="0 0 24 24"
            aria-hidden="true"
            animate={{ rotate: 360 }}
            transition={{ duration: 0.7, repeat: Infinity, ease: "linear" }}
          >
            <circle className="docs-load-more-spin-track" cx="12" cy="12" r="8" />
            <path className="docs-load-more-spin-arc" d="M12 4a8 8 0 0 1 8 8" />
          </motion.svg>
          <span>Syncing attachments…</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function LoadMoreButton({
  loading,
  onClick,
}: {
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      type="button"
      className="docs-load-more"
      data-loading={loading}
      aria-busy={loading}
      onClick={onClick}
      disabled={loading}
      whileHover={loading ? undefined : { y: -1 }}
      whileTap={loading ? undefined : { scale: 0.98 }}
      transition={snap}
    >
      <span className="docs-load-more-icon" aria-hidden="true">
        <AnimatePresence mode="wait" initial={false}>
          {loading ? (
            <motion.svg
              key="spin"
              viewBox="0 0 24 24"
              initial={{ opacity: 0, scale: 0.5 }}
              animate={{ opacity: 1, scale: 1, rotate: 360 }}
              exit={{ opacity: 0, scale: 0.5 }}
              transition={{
                opacity: snapFast,
                scale: snapFast,
                rotate: { duration: 0.7, repeat: Infinity, ease: "linear" },
              }}
            >
              <circle
                className="docs-load-more-spin-track"
                cx="12"
                cy="12"
                r="8"
              />
              <path
                className="docs-load-more-spin-arc"
                d="M12 4a8 8 0 0 1 8 8"
              />
            </motion.svg>
          ) : (
            <motion.svg
              key="chev"
              viewBox="0 0 24 24"
              initial={{ opacity: 0, y: -3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 3 }}
              transition={snapFast}
            >
              <path d="M6 10l6 6 6-6" />
            </motion.svg>
          )}
        </AnimatePresence>
      </span>
      <span className="docs-load-more-label">
        {loading ? "Loading more" : "Load more"}
      </span>
      {!loading && <Kbd>M</Kbd>}
    </motion.button>
  );
}

function DocPreview({
  doc,
  onClose,
}: {
  doc: DocItem | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const open = Boolean(doc);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const previewKey = doc ? docKey(doc) : "";
  useFocusTrap(ref, open);

  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [previewKey]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const kind = previewKind(doc);

  return (
    <AnimatePresence>
      {doc && (
        <>
          <motion.div
            className="scrim"
            variants={scrim}
            initial="initial"
            animate="animate"
            exit="exit"
            onClick={onClose}
          />
          <motion.aside
            ref={ref}
            className="agent-drawer doc-preview"
            variants={drawerRight}
            initial="initial"
            animate="animate"
            exit="exit"
            role="dialog"
            aria-modal="true"
            aria-label={doc.filename}
          >
            <div className="agent-drawer-head">
              <span className="doc-preview-title" title={doc.filename}>
                {doc.filename}
              </span>
              <div className="doc-preview-actions">
                <a
                  className="icon-btn"
                  href={previewUrl(doc, "attachment")}
                  aria-label="Download"
                  title="Download"
                >
                  <DownloadIcon size={16} />
                </a>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={onClose}
                  aria-label="Close preview"
                >
                  <CloseIcon size={16} />
                </button>
              </div>
            </div>
            <div className="doc-preview-body">
              {(kind === "pdf" || kind === "image") && !loaded && !failed && (
                <div className="doc-preview-loading" role="status">
                  <HelmLoader size={34} />
                  <span>Loading preview</span>
                </div>
              )}
              {kind === "pdf" && (
                <iframe
                  // Remount per document so the prior PDF's bytes never linger
                  // when switching docs without closing the drawer.
                  key={previewKey}
                  className="doc-preview-frame"
                  src={previewUrl(doc, "inline")}
                  title={doc.filename}
                  onLoad={() => setLoaded(true)}
                />
              )}
              {kind === "image" && !failed && (
                <div className="doc-preview-imgwrap">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    key={previewKey}
                    className="doc-preview-img"
                    src={previewUrl(doc, "inline")}
                    alt={doc.filename}
                    onLoad={() => setLoaded(true)}
                    onError={() => setFailed(true)}
                  />
                </div>
              )}
              {failed && (
                <div className="empty docs-empty">
                  <DocumentsIcon size={28} />
                  <p>Preview failed to load.</p>
                  <a className="btn" href={previewUrl(doc, "attachment")}>
                    Download to open
                  </a>
                </div>
              )}
              {kind === "none" && (
                <div className="empty docs-empty">
                  <DocumentsIcon size={28} />
                  <p>No in-app preview for this file type.</p>
                  <a className="btn" href={previewUrl(doc, "attachment")}>
                    Download to open
                  </a>
                </div>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
