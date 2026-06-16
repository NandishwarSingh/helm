"use client";

import { useEffect } from "react";
import { Command } from "cmdk";
import { AnimatePresence, motion } from "motion/react";

import {
  AgentIcon,
  CalendarIcon,
  ComposeIcon,
  ContrastIcon,
  HelpIcon,
  MailIcon,
  PlusIcon,
  RefreshIcon,
  SignOutIcon,
} from "@/components/icons";
import { Kbd } from "@/components/kbd";
import { dispatchAction } from "@/lib/actions";
import { paletteDrop, scrim } from "@/lib/motion";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (view: "mail" | "calendar" | "agent") => void;
  onCompose: () => void;
  onNewEvent: () => void;
  onHelp: () => void;
};

async function signOut() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } finally {
    window.location.assign("/");
  }
}

export function CommandPalette({
  open,
  onOpenChange,
  onNavigate,
  onCompose,
  onNewEvent,
  onHelp,
}: Props) {
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

  function run(action: () => void) {
    onOpenChange(false);
    action();
  }

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
            className="palette"
            variants={paletteDrop}
            initial="initial"
            animate="animate"
            exit="exit"
            role="dialog"
            aria-label="Command palette"
          >
            <Command label="Command palette">
              <Command.Input placeholder="Type a command…" autoFocus />
              <Command.List>
                <Command.Empty>No matching commands.</Command.Empty>

                <Command.Group heading="Actions">
                  <Command.Item onSelect={() => run(onCompose)}>
                    <ComposeIcon size={15} />
                    Compose message
                    <span className="palette-keys">
                      <Kbd>C</Kbd>
                    </span>
                  </Command.Item>
                  <Command.Item onSelect={() => run(onNewEvent)}>
                    <PlusIcon size={15} />
                    New calendar event
                    <span className="palette-keys">
                      <Kbd>N</Kbd>
                    </span>
                  </Command.Item>
                  <Command.Item
                    onSelect={() => run(() => dispatchAction("focus-search"))}
                  >
                    <MailIcon size={15} />
                    Search current view
                    <span className="palette-keys">
                      <Kbd>/</Kbd>
                    </span>
                  </Command.Item>
                  <Command.Item
                    onSelect={() => run(() => dispatchAction("refresh"))}
                  >
                    <RefreshIcon size={15} />
                    Refresh from Google
                  </Command.Item>
                </Command.Group>

                <Command.Group heading="Go to">
                  <Command.Item onSelect={() => run(() => onNavigate("mail"))}>
                    <MailIcon size={15} />
                    Mail
                    <span className="palette-keys">
                      <Kbd>1</Kbd>
                    </span>
                  </Command.Item>
                  <Command.Item
                    onSelect={() => run(() => onNavigate("calendar"))}
                  >
                    <CalendarIcon size={15} />
                    Calendar
                    <span className="palette-keys">
                      <Kbd>2</Kbd>
                    </span>
                  </Command.Item>
                  <Command.Item onSelect={() => run(() => onNavigate("agent"))}>
                    <AgentIcon size={15} />
                    Agent
                    <span className="palette-keys">
                      <Kbd>3</Kbd>
                    </span>
                  </Command.Item>
                </Command.Group>

                <Command.Group heading="Workspace">
                  <Command.Item
                    onSelect={() => run(() => dispatchAction("toggle-theme"))}
                  >
                    <ContrastIcon size={15} />
                    Toggle light / dark theme
                  </Command.Item>
                  <Command.Item onSelect={() => run(onHelp)}>
                    <HelpIcon size={15} />
                    Keyboard shortcuts
                    <span className="palette-keys">
                      <Kbd>?</Kbd>
                    </span>
                  </Command.Item>
                  <Command.Item onSelect={() => run(() => void signOut())}>
                    <SignOutIcon size={15} />
                    Sign out
                  </Command.Item>
                </Command.Group>
              </Command.List>
            </Command>
            <div className="palette-foot">
              <span>
                <Kbd>↑</Kbd> <Kbd>↓</Kbd> navigate
              </span>
              <span>
                <Kbd>↵</Kbd> select
              </span>
              <span>
                <Kbd>esc</Kbd> close
              </span>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
