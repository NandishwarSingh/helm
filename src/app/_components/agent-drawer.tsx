"use client";

import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";

import { AgentPanel } from "@/app/_components/agent-panel";
import { CloseIcon, HistoryIcon, PlusIcon } from "@/components/icons";
import { dispatchAction } from "@/lib/actions";

/**
 * The Agent as a right-side slide-over, usable from any view without leaving the
 * inbox. It renders the SAME AgentPanel as the full Agent tab — the chat state is
 * a module-level singleton, so the conversation, resolved cards and unsent input
 * are shared. AppShell guarantees the drawer and the tab are never mounted at the
 * same time (one Chat, one set of effects).
 */
export function AgentDrawer({
  open,
  account,
  onClose,
}: {
  open: boolean;
  account: string;
  onClose: () => void;
}) {
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

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          className="agent-drawer agent-drawer-side"
          // Fixed overlay that slides via translateX — motion drives this frame by
          // frame, so it's smooth in BOTH directions (the doc preview slides the
          // same way). The mail content reserves room via .frame's padding-right
          // transition, which shares this exact duration/easing, so the panel's
          // left edge and the content's right edge stay locked together.
          initial={{ x: "100%" }}
          animate={{ x: "0%" }}
          exit={{ x: "100%" }}
          transition={{ duration: 0.34, ease: [0.32, 0.72, 0, 1] }}
          role="complementary"
          aria-label="Agent"
        >
          <div className="agent-drawer-head">
            <span className="agent-drawer-title">Agent</span>
            <div className="agent-drawer-actions">
              <button
                type="button"
                className="icon-btn"
                onClick={() => dispatchAction("agent-history")}
                data-tip="Chat history"
                data-tip-pos="down"
                aria-label="Chat history"
              >
                <HistoryIcon size={16} />
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => dispatchAction("agent-new-chat")}
                data-tip="New chat"
                data-tip-pos="down"
                aria-label="New chat"
              >
                <PlusIcon size={16} />
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={onClose}
                aria-label="Close agent"
              >
                <CloseIcon size={16} />
              </button>
            </div>
          </div>
          <div className="agent-drawer-body">
            <AgentPanel account={account} inDrawer />
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
