"use client";

import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";

import { AgentPanel } from "@/app/_components/agent-panel";
import { CloseIcon } from "@/components/icons";

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
          className="agent-drawer agent-drawer-push"
          // The slide comes entirely from the .app grid column animating open and
          // closed. The panel itself stays fully OPAQUE on open (initial=false →
          // no translucent fade-in over the mail behind it); on close it fades as
          // it slides out, which also keeps it mounted for the column's collapse.
          initial={false}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.34, ease: [0.32, 0.72, 0, 1] }}
          role="complementary"
          aria-label="Agent"
        >
          <div className="agent-drawer-head">
            <span className="agent-drawer-title">Agent</span>
            <button
              type="button"
              className="icon-btn"
              onClick={onClose}
              aria-label="Close agent"
            >
              <CloseIcon size={16} />
            </button>
          </div>
          <div className="agent-drawer-body">
            <AgentPanel account={account} />
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
