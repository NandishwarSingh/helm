"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";

import { CalendarPanel } from "@/app/_components/calendar-panel";
import { ConnectScreen } from "@/app/_components/connect-screen";
import { GmailPanel } from "@/app/_components/gmail-panel";
import { BrandMark } from "@/components/brand-mark";
import {
  CalendarIcon,
  ComposeIcon,
  MailIcon,
  SignOutIcon,
} from "@/components/icons";
import { Kbd } from "@/components/kbd";
import { ThemeToggle } from "@/components/theme-toggle";
import { siteConfig } from "@/config/site";
import { viewSwap } from "@/lib/motion";
import { api } from "@/trpc/react";

type View = "mail" | "calendar";

export default function Home() {
  const [view, setView] = useState<View>("mail");
  const [composeOpen, setComposeOpen] = useState(false);

  const status = api.connection.status.useQuery();
  const connected = Boolean(status.data?.gmail ?? status.data?.calendar);
  const showApp = Boolean(status.data?.gmail ?? status.data?.calendar);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;

      if (isTyping) return;
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
        <BrandMark size={20} />
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
            {view === "mail" && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setComposeOpen(true)}
              >
                <ComposeIcon size={15} />
                Compose
                <Kbd>C</Kbd>
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
                  />
                ) : (
                  <CalendarPanel />
                )}
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
      </div>
    </MotionConfig>
  );
}
