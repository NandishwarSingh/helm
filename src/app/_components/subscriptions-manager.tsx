"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import { CloseIcon } from "@/components/icons";
import { scrim, slideOver } from "@/lib/motion";
import { useFocusTrap } from "@/lib/use-focus-trap";
import { api } from "@/trpc/react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "all" (every connected account) or a specific account id. */
  account: string;
  accounts: { id: string; email: string }[];
};

const METHOD_LABEL: Record<string, string> = {
  "one-click": "1-click",
  email: "by email",
  manual: "opens link",
};

/**
 * PRO: scan the user's mail for senders they can unsubscribe from, multi-select,
 * and unsubscribe in bulk. All detection + the actual unsubscribe happen on the
 * server (`gmail.listSubscriptions` / `gmail.unsubscribeMany`, both Pro-gated and
 * ownership-checked); this only renders the list and the result. Spans every
 * account when `account` is "all".
 */
export function SubscriptionsManager({
  open,
  onOpenChange,
  account,
  accounts,
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);
  const utils = api.useUtils();

  const scope = account === "all" ? undefined : account;
  const list = api.gmail.listSubscriptions.useQuery(
    { account: scope },
    { enabled: open, staleTime: 60_000, refetchOnWindowFocus: false },
  );
  const unsub = api.gmail.unsubscribeMany.useMutation();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [summary, setSummary] = useState<{
    done: number;
    manual: { url: string; sender: string }[];
  } | null>(null);

  const subs = useMemo(() => list.data?.subscriptions ?? [], [list.data]);
  const keyOf = (s: { accountId: string; messageId: string }) =>
    `${s.accountId}:${s.messageId}`;
  const accountEmail = (id: string) =>
    accounts.find((a) => a.id === id)?.email ?? "";
  const multi = account === "all" && accounts.length > 1;

  // Clear transient state each time the dialog closes.
  useEffect(() => {
    if (!open) {
      setSelected(new Set());
      setSummary(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onOpenChange(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  const allKeys = useMemo(() => subs.map(keyOf), [subs]);
  const allSelected =
    allKeys.length > 0 && allKeys.every((k) => selected.has(k));

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(allKeys));
  }

  async function unsubscribeSelected() {
    if (unsub.isPending) return;
    const chosen = subs.filter((s) => selected.has(keyOf(s)));
    if (chosen.length === 0) return;
    const senderByKey = new Map(subs.map((s) => [keyOf(s), s.senderName]));
    try {
      const res = await unsub.mutateAsync({
        items: chosen.map((s) => ({ id: s.messageId, account: s.accountId })),
      });
      const done = res.results.filter(
        (r) => r.ok && (r.method === "one-click" || r.method === "email"),
      ).length;
      const manual = res.results
        .filter((r) => r.method === "manual" && r.manualUrl)
        .map((r) => ({
          url: r.manualUrl!,
          sender: senderByKey.get(`${r.account}:${r.id}`) ?? r.sender,
        }));
      setSummary({ done, manual });
      setSelected(new Set());
      // Unsubscribed senders are suppressed server-side, so they drop off here.
      await utils.gmail.listSubscriptions.invalidate();
    } catch {
      setSummary({ done: 0, manual: [] });
    }
  }

  const selectedCount = selected.size;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="scrim"
            variants={scrim}
            initial="initial"
            animate="animate"
            exit="exit"
            onClick={() => onOpenChange(false)}
          />
          <motion.div
            ref={dialogRef}
            className="compose subscriptions"
            variants={slideOver}
            initial="initial"
            animate="animate"
            exit="exit"
            role="dialog"
            aria-modal="true"
            aria-label="Manage subscriptions"
          >
            <div className="compose-head">
              Subscriptions
              <span className="topbar-spacer" />
              {subs.length > 0 && (
                <button
                  type="button"
                  className="subs-selectall"
                  onClick={toggleAll}
                >
                  {allSelected ? "Clear" : "Select all"}
                </button>
              )}
              <button
                type="button"
                className="icon-btn"
                onClick={() => onOpenChange(false)}
                aria-label="Close"
              >
                <CloseIcon size={16} />
              </button>
            </div>

            <div className="compose-body subs-body">
              {summary && (
                <div className="subs-summary">
                  {summary.done > 0 && (
                    <p className="subs-summary-done">
                      ✓ Unsubscribed from {summary.done}
                      {summary.done === 1 ? " sender" : " senders"}.
                    </p>
                  )}
                  {summary.manual.length > 0 && (
                    <div className="subs-summary-manual">
                      <p>
                        {summary.manual.length}
                        {summary.manual.length === 1
                          ? " sender needs"
                          : " senders need"}{" "}
                        a manual click:
                      </p>
                      <ul>
                        {summary.manual.map((m) => (
                          <li key={m.url}>
                            <a
                              href={m.url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {m.sender || m.url}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {summary.done === 0 && summary.manual.length === 0 && (
                    <p className="error">
                      Couldn&apos;t unsubscribe — try again.
                    </p>
                  )}
                </div>
              )}

              {list.isLoading ? (
                <div className="subs-state">
                  <span className="mini-spinner" />
                  <span>
                    Scanning your mail
                    {multi ? " across all accounts" : ""}…
                  </span>
                </div>
              ) : list.isError ? (
                <p className="error">
                  Couldn&apos;t load your subscriptions. Please try again.
                </p>
              ) : subs.length === 0 ? (
                <div className="subs-state subs-empty">
                  <p>No newsletters to unsubscribe from. 🎉</p>
                  <p className="subs-empty-sub">
                    You&apos;re all caught up — nothing in your mail exposes an
                    unsubscribe link.
                  </p>
                </div>
              ) : (
                <ul className="subs-list">
                  {subs.map((s) => {
                    const key = keyOf(s);
                    const on = selected.has(key);
                    return (
                      <li key={key} className="subs-row" data-on={on}>
                        <label className="subs-pick">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => toggle(key)}
                          />
                          <span className="subs-meta">
                            <span className="subs-name">{s.senderName}</span>
                            <span className="subs-email">
                              {s.senderEmail}
                              {multi && accountEmail(s.accountId)
                                ? ` · ${accountEmail(s.accountId)}`
                                : ""}
                            </span>
                          </span>
                        </label>
                        <span className="subs-tags">
                          <span className="subs-count">
                            {s.count} {s.count === 1 ? "email" : "emails"}
                          </span>
                          <span className="subs-method" data-method={s.method}>
                            {METHOD_LABEL[s.method] ?? s.method}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {subs.length > 0 && (
              <div className="subs-foot">
                <button
                  type="button"
                  className="btn btn-primary subs-cta"
                  disabled={selectedCount === 0 || unsub.isPending}
                  onClick={() => void unsubscribeSelected()}
                >
                  {unsub.isPending
                    ? "Unsubscribing…"
                    : selectedCount > 0
                      ? `Unsubscribe ${selectedCount} selected`
                      : "Select senders to unsubscribe"}
                </button>
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
