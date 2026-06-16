"use client";

import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";

import { CloseIcon } from "@/components/icons";
import { Kbd } from "@/components/kbd";
import { scrim, slideOver } from "@/lib/motion";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type Row = { keys: string[]; label: string };

const GROUPS: { title: string; rows: Row[] }[] = [
  {
    title: "Global",
    rows: [
      { keys: ["⌘", "K"], label: "Command palette" },
      { keys: ["1"], label: "Go to Mail" },
      { keys: ["2"], label: "Go to Calendar" },
      { keys: ["G"], label: "Then I S A P T D — jump to a folder" },
      { keys: ["G", "C"], label: "Jump to Calendar" },
      { keys: ["/"], label: "Search current view" },
      { keys: ["?"], label: "Keyboard shortcuts" },
      { keys: ["Esc"], label: "Close the topmost thing" },
    ],
  },
  {
    title: "Mail",
    rows: [
      { keys: ["J"], label: "Next message / draft" },
      { keys: ["K"], label: "Previous message / draft" },
      { keys: ["Space"], label: "Scroll the open message" },
      { keys: ["X"], label: "Select for bulk actions" },
      { keys: ["⌘", "A"], label: "Select all loaded" },
      { keys: ["E"], label: "Archive / restore (acts on selection)" },
      { keys: ["#"], label: "Trash or delete (acts on selection)" },
      { keys: ["S"], label: "Star / unstar" },
      { keys: ["⇧", "U"], label: "Mark unread / read" },
      { keys: ["R"], label: "Reply" },
      { keys: ["F"], label: "Forward" },
      { keys: ["T"], label: "Turn into calendar event" },
      { keys: ["U"], label: "Back / clear selection" },
    ],
  },
  {
    title: "Compose",
    rows: [
      { keys: ["⌘", "↵"], label: "Send" },
      { keys: ["⌘", "S"], label: "Save draft" },
      { keys: ["Esc"], label: "Close" },
    ],
  },
  {
    title: "Calendar",
    rows: [
      { keys: ["J"], label: "Next event" },
      { keys: ["K"], label: "Previous event" },
      { keys: ["↵"], label: "Edit selected event" },
      { keys: ["#"], label: "Delete selected event" },
      { keys: ["H"], label: "Previous week" },
      { keys: ["L"], label: "Next week" },
      { keys: ["T"], label: "Today" },
      { keys: ["N"], label: "New event" },
      { keys: ["⌘", "↵"], label: "Save / send (in dialog)" },
    ],
  },
];

export function ShortcutsHelp({ open, onOpenChange }: Props) {
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
            className="compose help"
            variants={slideOver}
            initial="initial"
            animate="animate"
            exit="exit"
            role="dialog"
            aria-label="Keyboard shortcuts"
          >
            <div className="compose-head">
              Keyboard shortcuts
              <span className="topbar-spacer" />
              <button
                type="button"
                className="icon-btn"
                onClick={() => onOpenChange(false)}
                aria-label="Close"
              >
                <CloseIcon size={16} />
              </button>
            </div>
            <div className="compose-body help-body">
              {GROUPS.map((group) => (
                <section key={group.title} className="help-group">
                  <h3>{group.title}</h3>
                  {group.rows.map((row) => (
                    <div className="help-row" key={row.label}>
                      <span>{row.label}</span>
                      <span className="help-keys">
                        {row.keys.map((key) => (
                          <Kbd key={key}>{key}</Kbd>
                        ))}
                      </span>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
