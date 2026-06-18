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
import { useAction, useOverlay } from "@/lib/actions";
import { drawerRight, listRow, scrim, viewSwap } from "@/lib/motion";
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

export function DocumentsPanel({ account }: { account: string }) {
  const utils = api.useUtils();
  const [groupBy, setGroupBy] = useState<GroupBy>("type");
  const [category, setCategory] = useState<Category>("all");
  const [limit, setLimit] = useState(60);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [preview, setPreview] = useState<DocItem | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

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

  const listInput = { category, account, limit };
  const listQuery = api.documents.list.useQuery(listInput, {
    enabled: !searching,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
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
      if (kind === "documents" || kind === "mail") refreshRef.current();
    });
    return () => source.close();
  }, []);

  // Palette / global shortcuts: "/" focuses search, Refresh triggers a scan.
  useAction("focus-search", () => searchRef.current?.focus());
  useAction("refresh", () => {
    if (!scan.isPending) scan.mutate();
  });

  function togglePin(doc: DocItem) {
    setPin.mutate({
      messageId: doc.messageId,
      attachmentId: doc.attachmentId,
      account: doc.accountId,
      pinned: !doc.pinned,
    });
  }

  const facetCounts = facetsQuery.data?.counts ?? {};
  const facetTotal = facetsQuery.data?.total ?? 0;
  const visibleCategories = CATEGORY_ORDER.filter((c) => (facetCounts[c] ?? 0) > 0);

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
  const hasMore = !searching && (listQuery.data?.hasMore ?? false);
  const loading =
    (searching ? searchQuery.isLoading : listQuery.isLoading) &&
    items.length === 0;
  const empty = !loading && items.length === 0;

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
          onClick={() => scan.mutate()}
          data-spinning={scan.isPending}
          disabled={scan.isPending}
          aria-label="Scan for new documents"
          title="Scan mail for new attachments"
        >
          <RefreshIcon size={16} />
        </button>
      </div>

      <div className="docs-chips" role="group" aria-label="Filter by type">
        <button
          type="button"
          className="docs-chip"
          data-active={category === "all"}
          onClick={() => setCategory("all")}
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
            onClick={() => setCategory(c)}
          >
            {CATEGORY_LABEL[c]}
            <span className="docs-chip-n">{facetCounts[c]}</span>
          </button>
        ))}
      </div>

      <div className="docs-scroll">
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
                onClick={() => scan.mutate()}
                disabled={scan.isPending}
              >
                {scan.isPending ? "Scanning…" : "Scan now"}
              </button>
            )}
          </div>
        )}

        {!loading &&
          groups.map((group) => (
            <section key={group.key} className="docs-group">
              <header className="docs-group-head">
                {group.key === "__pinned" && <PinIcon size={13} />}
                <span>{group.label}</span>
                <span className="docs-group-n">{group.docs.length}</span>
              </header>
              <ul className="docs-rows">
                {group.docs.map((doc, i) => (
                  <motion.li
                    key={docKey(doc)}
                    className="docs-row"
                    data-pinned={doc.pinned}
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
                      onClick={() => setPreview(doc)}
                    >
                      <span className="docs-row-icon">
                        <DocumentsIcon size={16} />
                      </span>
                      <span className="docs-row-main">
                        <span className="docs-row-name" title={doc.filename}>
                          {doc.filename}
                        </span>
                        <span className="docs-row-sub">
                          {doc.sender || "Unknown sender"}
                          {doc.subject ? ` · ${doc.subject}` : ""}
                        </span>
                      </span>
                      {account === "all" && multiAccount && (
                        <span
                          className="row-acct"
                          style={{ background: accountColor(doc.accountId) }}
                          title={doc.accountEmail}
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
                    </button>
                    <button
                      type="button"
                      className="icon-btn docs-row-act"
                      data-on={doc.pinned}
                      onClick={() => togglePin(doc)}
                      aria-label={doc.pinned ? "Unpin" : "Pin to top"}
                      aria-pressed={doc.pinned}
                      title={doc.pinned ? "Unpin" : "Pin to top"}
                    >
                      <PinIcon size={15} filled={doc.pinned} />
                    </button>
                    <a
                      className="icon-btn docs-row-act"
                      href={previewUrl(doc, "attachment")}
                      aria-label={`Download ${doc.filename}`}
                      title="Download"
                    >
                      <DownloadIcon size={15} />
                    </a>
                  </motion.li>
                ))}
              </ul>
            </section>
          ))}

        {hasMore && (
          <div className="docs-more">
            <button
              type="button"
              className="btn"
              onClick={() => setLimit((l) => Math.min(l + 60, 200))}
            >
              Load more
            </button>
          </div>
        )}
      </div>

      <DocPreview doc={preview} onClose={() => setPreview(null)} />
    </motion.div>
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
  useFocusTrap(ref, open);

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

  const kind: "pdf" | "image" | "none" = !doc
    ? "none"
    : doc.category === "pdf" || doc.mimeType === "application/pdf"
      ? "pdf"
      : doc.category === "image"
        ? "image"
        : "none";

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
              {kind === "pdf" && (
                <iframe
                  // Remount per document so the prior PDF's bytes never linger
                  // when switching docs without closing the drawer.
                  key={docKey(doc)}
                  className="doc-preview-frame"
                  src={previewUrl(doc, "inline")}
                  title={doc.filename}
                />
              )}
              {kind === "image" && (
                <div className="doc-preview-imgwrap">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    key={docKey(doc)}
                    className="doc-preview-img"
                    src={previewUrl(doc, "inline")}
                    alt={doc.filename}
                  />
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
