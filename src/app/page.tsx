"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";

import { CalendarPanel } from "@/app/_components/calendar-panel";
import { ConnectScreen } from "@/app/_components/connect-screen";
import { GmailPanel, type EventSeed } from "@/app/_components/gmail-panel";
import { BrandMark } from "@/components/brand-mark";
import { CommandPalette } from "@/components/command-palette";
import { HelmLoader } from "@/components/helm-loader";
import {
  CalendarIcon,
  ComposeIcon,
  HelpIcon,
  MailIcon,
  PlusIcon,
  SignOutIcon,
} from "@/components/icons";
import { Kbd } from "@/components/kbd";
import { ShortcutsHelp } from "@/components/shortcuts-help";
import { ThemeToggle } from "@/components/theme-toggle";
import { siteConfig } from "@/config/site";
import { dispatchAction, hasOverlay, isTypingTarget, useOverlay } from "@/lib/actions";
import { viewSwap } from "@/lib/motion";
import { api } from "@/trpc/react";

type View = "mail" | "calendar";

export default function Home() {
  const [view, setView] = useState<View>("mail");
  const [composeOpen, setComposeOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [eventSeed, setEventSeed] = useState<EventSeed | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  // While any overlay is open, panel keyboard handlers stand down.
  useOverlay(composeOpen);
  useOverlay(createOpen);
  useOverlay(paletteOpen);
  useOverlay(helpOpen);

  const status = api.connection.status.useQuery();
  const connected = Boolean(status.data?.gmail ?? status.data?.calendar);
  const showApp = Boolean(status.data?.gmail ?? status.data?.calendar);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      // The palette toggle works everywhere, including inside inputs.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }

      if (isTypingTarget(event.target) || hasOverlay()) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.key) {
        case "1":
          setView("mail");
          break;
        case "2":
          setView("calendar");
          break;
        case "c":
          setView("mail");
          setComposeOpen(true);
          break;
        case "n":
          setView("calendar");
          setCreateOpen(true);
          break;
        case "/":
          dispatchAction("focus-search");
          break;
        case "?":
          setHelpOpen(true);
          break;
        default:
          return;
      }
      event.preventDefault();
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (status.isLoading) {
    return (
      <div className="splash">
        <HelmLoader size={44} />
      </div>
    );
  }

  if (!showApp) {
    return <ConnectScreen />;
  }

  return (
    <MotionConfig reducedMotion="user">
      <div className="app">
        <aside className="rail">
          <div className="rail-brand">
            <BrandMark />
            {siteConfig.name}
          </div>

          <nav className="rail-nav">
            <button
              type="button"
              className="rail-item"
              data-active={view === "mail"}
              onClick={() => setView("mail")}
            >
              <MailIcon />
              Mail
              <Kbd>1</Kbd>
            </button>
            <button
              type="button"
              className="rail-item"
              data-active={view === "calendar"}
              onClick={() => setView("calendar")}
            >
              <CalendarIcon />
              Calendar
              <Kbd>2</Kbd>
            </button>
          </nav>

          <div className="rail-foot">
            <span className="rail-status">
              {connected ? "Google connected" : "Not connected"}
            </span>
            <ThemeToggle />
            <form action="/api/auth/logout" method="post">
              <button type="submit" className="icon-btn" title="Sign out">
                <SignOutIcon size={15} />
              </button>
            </form>
          </div>
        </aside>

        <div className="frame">
          <header className="topbar">
            <span className="topbar-title">
              {view === "mail" ? "Mail" : "Calendar"}
            </span>
            <span className="topbar-spacer" />
            <button
              type="button"
              className="icon-btn"
              title="Keyboard shortcuts ( ? )"
              onClick={() => setHelpOpen(true)}
            >
              <HelpIcon size={15} />
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setPaletteOpen(true)}
            >
              Commands
              <Kbd>⌘K</Kbd>
            </button>
            {view === "mail" ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setComposeOpen(true)}
              >
                <ComposeIcon size={15} />
                Compose
                <Kbd>C</Kbd>
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setCreateOpen(true)}
              >
                <PlusIcon size={15} />
                New event
                <Kbd>N</Kbd>
              </button>
            )}
          </header>

          <main className="content">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={view}
                variants={viewSwap}
                initial="initial"
                animate="animate"
                exit="exit"
                style={{ height: "100%" }}
              >
                {view === "mail" ? (
                  <GmailPanel
                    composeOpen={composeOpen}
                    onComposeOpenChange={setComposeOpen}
                    onAddToCalendar={(seed) => {
                      setEventSeed(seed);
                      setView("calendar");
                      setCreateOpen(true);
                    }}
                  />
                ) : (
                  <CalendarPanel
                    createOpen={createOpen}
                    onCreateOpenChange={setCreateOpen}
                    seed={eventSeed}
                    onSeedConsumed={() => setEventSeed(null)}
                  />
                )}
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onNavigate={setView}
        onCompose={() => {
          setView("mail");
          setComposeOpen(true);
        }}
        onNewEvent={() => {
          setView("calendar");
          setCreateOpen(true);
        }}
        onHelp={() => setHelpOpen(true)}
      />
      <ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />
    </MotionConfig>
  );
}
