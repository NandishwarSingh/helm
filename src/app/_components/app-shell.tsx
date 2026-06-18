"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";

import dynamic from "next/dynamic";

import { CalendarPanel } from "@/app/_components/calendar-panel";
import { FirstSyncVeil } from "@/components/first-sync-veil";
import { Landing } from "@/app/_components/landing";
import { UpgradePro } from "@/app/_components/upgrade-pro";
import {
  GmailPanel,
  type EventSeed,
  type MailView,
} from "@/app/_components/gmail-panel";
import { BrandMark } from "@/components/brand-mark";
import { CommandPalette } from "@/components/command-palette";
import { HelmLoader } from "@/components/helm-loader";
import {
  AgentIcon,
  ArchiveIcon,
  CalendarIcon,
  ComposeIcon,
  FlagIcon,
  HelpIcon,
  InboxIcon,
  MailIcon,
  PlusIcon,
  SendIcon,
  SignOutIcon,
  SpamIcon,
  StarIcon,
  TrashIcon,
} from "@/components/icons";
import { Kbd } from "@/components/kbd";
import { ShortcutsHelp } from "@/components/shortcuts-help";
import { ThemeToggle } from "@/components/theme-toggle";
import { siteConfig } from "@/config/site";
import { dispatchAction, hasOverlay, isTypingTarget, useOverlay } from "@/lib/actions";
import { useFocusTrap } from "@/lib/use-focus-trap";
import { chordBar, viewSwap } from "@/lib/motion";
import { api } from "@/trpc/react";

type View = "mail" | "calendar" | "agent";

// The agent (and its chat runtime) loads only when the view is opened.
const AgentPanel = dynamic(
  () => import("@/app/_components/agent-panel").then((m) => m.AgentPanel),
  {
    ssr: false,
    // Same branded loader the calendar view shows while its chunk/data loads.
    loading: () => (
      <div className="empty" style={{ flex: 1 }}>
        <HelmLoader size={40} />
      </div>
    ),
  },
);

const MAIL_FOLDERS: {
  id: MailView;
  label: string;
  chord: string;
  icon: React.ReactNode;
}[] = [
  { id: "inbox", label: "Inbox", chord: "I", icon: <InboxIcon size={15} /> },
  { id: "priority", label: "Priority", chord: "U", icon: <FlagIcon size={15} /> },
  { id: "starred", label: "Starred", chord: "S", icon: <StarIcon size={15} /> },
  { id: "archived", label: "Archive", chord: "A", icon: <ArchiveIcon size={15} /> },
  { id: "spam", label: "Spam", chord: "P", icon: <SpamIcon size={15} /> },
  { id: "trash", label: "Trash", chord: "T", icon: <TrashIcon size={15} /> },
  { id: "sent", label: "Sent", chord: "E", icon: <SendIcon size={15} /> },
  { id: "drafts", label: "Drafts", chord: "D", icon: <ComposeIcon size={15} /> },
];

function ChevronIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="acct-chev"
    >
      <path
        d="M4 6l4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function AppShell() {
  const [view, setView] = useState<View>("mail");
  const [mailView, setMailView] = useState<MailView>("inbox");
  const [chordPending, setChordPending] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [eventSeed, setEventSeed] = useState<EventSeed | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // The first load straight out of Google consent gets the tearable veil while
  // the initial sync runs. The ?connected=1 marker is stripped immediately so a
  // refresh never replays it.
  const [firstRun, setFirstRun] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("connected") === "1") {
      setFirstRun(true);
      params.delete("connected");
      const query = params.toString();
      window.history.replaceState(
        null,
        "",
        window.location.pathname + (query ? `?${query}` : ""),
      );
    }
  }, []);

  // While any overlay is open, panel keyboard handlers stand down.
  useOverlay(composeOpen);
  useOverlay(createOpen);
  useOverlay(paletteOpen);
  useOverlay(helpOpen);

  const status = api.connection.status.useQuery();
  const showApp = Boolean(status.data?.gmail ?? status.data?.calendar);

  // Multi-account: the switcher's selection ("all" or a specific account id) is
  // threaded into every panel so reads fan out / scope and per-op calls land on
  // the right mailbox.
  const utils = api.useUtils();
  const accounts = api.accounts.list.useQuery(undefined, { staleTime: 30_000 });
  const accountList = accounts.data?.accounts ?? [];
  const multiAccount = accounts.data?.multi ?? false;
  const [activeAccount, setActiveAccount] = useState<string>("all");
  const [acctMenuOpen, setAcctMenuOpen] = useState(false);
  // The menu element gets a stable id so the trigger can point aria-controls at
  // it; the ref drives both the focus trap and arrow-key roving navigation.
  const acctMenuId = "acct-menu";
  const acctMenuRef = useRef<HTMLDivElement>(null);
  // Tab is trapped inside the open menu; on close useFocusTrap returns focus to
  // whatever held it when the menu opened — i.e. the trigger button.
  useFocusTrap(acctMenuRef, acctMenuOpen);
  // Background inert: when a full-screen overlay that renders OUTSIDE the .app
  // container is open (the command palette, the shortcuts dialog), make the
  // whole app inert + aria-hidden so a screen-reader virtual cursor can't reach
  // the obscured background. The account menu and the compose/event dialogs all
  // render INSIDE .app, so inerting .app would swallow them too — those rely on
  // their own focus trap + scrim instead. The overlay registry (useOverlay) is
  // a non-reactive counter for key handlers, so we derive this from state.
  const backgroundInert = paletteOpen || helpOpen;
  const setActiveAccountM = api.accounts.setActive.useMutation();
  function pickAccount(id: string) {
    setActiveAccount(id);
    setAcctMenuOpen(false);
    if (id !== "all") setActiveAccountM.mutate({ accountId: id });
    void utils.gmail.invalidate();
    void utils.triage.invalidate();
    void utils.calendar.invalidate();
  }
  const activeLabel =
    activeAccount === "all"
      ? multiAccount
        ? "All accounts"
        : (accountList[0]?.email ?? "Google connected")
      : (accountList.find((a) => a.id === activeAccount)?.email ?? "Account");
  const activeDot =
    activeAccount === "all"
      ? "var(--color-accent)"
      : (accountList.find((a) => a.id === activeAccount)?.color ??
        "var(--color-accent)");
  const setPrimaryM = api.accounts.setPrimary.useMutation({
    onSuccess: () => void utils.accounts.list.invalidate(),
  });
  const removeM = api.accounts.remove.useMutation({
    onSuccess: () => {
      void utils.accounts.list.invalidate();
      void utils.gmail.invalidate();
      void utils.triage.invalidate();
      void utils.calendar.invalidate();
    },
  });
  // "Add account" is an authenticated form POST (intent=add); submit one
  // programmatically so it can be triggered from the menu or the palette.
  function addAccount() {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/api/oauth/start";
    const field = document.createElement("input");
    field.type = "hidden";
    field.name = "intent";
    field.value = "add";
    form.appendChild(field);
    document.body.appendChild(form);
    form.submit();
  }
  // Esc closes the open account menu; Up/Down/Home/End rove between menuitems.
  useEffect(() => {
    if (!acctMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setAcctMenuOpen(false);
        return;
      }
      if (
        e.key !== "ArrowDown" &&
        e.key !== "ArrowUp" &&
        e.key !== "Home" &&
        e.key !== "End"
      ) {
        return;
      }
      const menu = acctMenuRef.current;
      if (!menu) return;
      const items = Array.from(
        menu.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ).filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      e.preventDefault();
      const current = document.activeElement as HTMLElement | null;
      const index = current ? items.indexOf(current) : -1;
      let next: HTMLElement | undefined;
      if (e.key === "Home") {
        next = items[0];
      } else if (e.key === "End") {
        next = items[items.length - 1];
      } else if (e.key === "ArrowDown") {
        next = items[index < 0 ? 0 : (index + 1) % items.length];
      } else {
        next = items[index <= 0 ? items.length - 1 : index - 1];
      }
      next?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [acctMenuOpen]);

  // G-chords: G then a second key jumps anywhere. Runs in the capture phase
  // so a consumed chord key never reaches the panel handlers.
  useEffect(() => {
    if (!chordPending) return;
    const timeout = window.setTimeout(() => setChordPending(false), 1600);
    function onChordKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // If focus moved into an input or an overlay opened after G was pressed,
      // let this keystroke through and quietly drop the chord — never hijack
      // what the user is now typing.
      if (isTypingTarget(event.target) || hasOverlay()) {
        setChordPending(false);
        return;
      }
      // Holding G produces key repeats; swallow them without cancelling.
      if (event.repeat && event.key.toLowerCase() === "g") {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setChordPending(false);
      const go = (folder: MailView) => {
        setView("mail");
        setMailView(folder);
      };
      switch (event.key.toLowerCase()) {
        case "i": go("inbox"); break;
        case "u": go("priority"); break;
        case "s": go("starred"); break;
        case "a": go("archived"); break;
        case "p": go("spam"); break;
        case "t": go("trash"); break;
        case "e": go("sent"); break;
        case "d": go("drafts"); break;
        case "m": setView("mail"); break;
        case "c": setView("calendar"); break;
        default: break; // unknown key just cancels the chord
      }
    }
    window.addEventListener("keydown", onChordKey, { capture: true });
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("keydown", onChordKey, { capture: true });
    };
  }, [chordPending]);

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
        case "g":
          if (event.repeat) break;
          setChordPending(true);
          break;
        case "1":
          setView("mail");
          break;
        case "2":
          setView("calendar");
          break;
        case "3":
          setView("agent");
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
    return <Landing />;
  }

  return (
    <MotionConfig reducedMotion="user">
      <div
        className="app"
        inert={backgroundInert}
        aria-hidden={backgroundInert || undefined}
      >
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
            <button
              type="button"
              className="rail-item"
              data-active={view === "agent"}
              onClick={() => setView("agent")}
            >
              <AgentIcon />
              Agent
              <Kbd>3</Kbd>
            </button>
          </nav>

          <div className="rail-divider" />

          <nav className="rail-nav rail-folders">
            {MAIL_FOLDERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className="rail-item rail-sub"
                data-active={view === "mail" && mailView === f.id}
                onClick={() => {
                  setView("mail");
                  setMailView(f.id);
                }}
              >
                {f.icon}
                {f.label}
                <span className="rail-keys">
                  <Kbd>G</Kbd>
                  <Kbd>{f.chord}</Kbd>
                </span>
              </button>
            ))}
          </nav>

          <div className="rail-foot">
            <div className="acct-switch">
              <button
                type="button"
                className="acct-current"
                onClick={() => setAcctMenuOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={acctMenuOpen}
                aria-controls={acctMenuId}
                title={activeLabel}
              >
                <span className="acct-dot" style={{ background: activeDot }} />
                <span className="acct-label">{activeLabel}</span>
                <ChevronIcon />
              </button>
              {acctMenuOpen && (
                <>
                  <div
                    className="acct-menu-scrim"
                    aria-hidden="true"
                    onClick={() => setAcctMenuOpen(false)}
                  />
                  <div
                    id={acctMenuId}
                    ref={acctMenuRef}
                    className="acct-menu"
                    role="menu"
                    aria-label="Switch account"
                  >
                    {multiAccount && (
                      <button
                        type="button"
                        role="menuitem"
                        className="acct-opt"
                        data-on={activeAccount === "all"}
                        onClick={() => pickAccount("all")}
                      >
                        <span
                          className="acct-dot"
                          style={{ background: "var(--color-accent)" }}
                        />
                        <span className="acct-opt-email">All accounts</span>
                      </button>
                    )}
                    {accountList.map((a) => (
                      <div
                        key={a.id}
                        className="acct-row"
                        data-on={activeAccount === a.id}
                      >
                        <button
                          type="button"
                          role="menuitem"
                          className="acct-opt acct-pick"
                          onClick={() => pickAccount(a.id)}
                          title={a.email}
                        >
                          <span
                            className="acct-dot"
                            style={{
                              background: a.color ?? "var(--color-accent)",
                            }}
                          />
                          <span className="acct-opt-email">{a.email}</span>
                        </button>
                        {a.isPrimary ? (
                          <span className="acct-tag">primary</span>
                        ) : (
                          multiAccount && (
                            <button
                              type="button"
                              role="menuitem"
                              className="acct-mini"
                              title="Make primary"
                              aria-label={`Make ${a.email} primary`}
                              onClick={() =>
                                setPrimaryM.mutate({ accountId: a.id })
                              }
                            >
                              <StarIcon size={12} />
                            </button>
                          )
                        )}
                        {multiAccount && (
                          <button
                            type="button"
                            role="menuitem"
                            className="acct-mini acct-remove"
                            title="Remove account"
                            aria-label={`Remove ${a.email}`}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Remove ${a.email}? It will be disconnected and its cached data deleted.`,
                                )
                              ) {
                                if (activeAccount === a.id) setActiveAccount("all");
                                removeM.mutate({ accountId: a.id });
                                setAcctMenuOpen(false);
                              }
                            }}
                          >
                            <TrashIcon size={12} />
                          </button>
                        )}
                      </div>
                    ))}
                    <form
                      action="/api/oauth/start"
                      method="post"
                      className="acct-add-form"
                    >
                      <input type="hidden" name="intent" value="add" />
                      <button
                        type="submit"
                        role="menuitem"
                        className="acct-opt acct-add"
                      >
                        <PlusIcon size={13} />
                        Add account
                      </button>
                    </form>
                  </div>
                </>
              )}
            </div>
            <ThemeToggle />
            <form action="/api/auth/logout" method="post">
              <button
                type="submit"
                className="icon-btn"
                data-tip="Sign out"
                aria-label="Sign out"
              >
                <SignOutIcon size={15} />
              </button>
            </form>
          </div>
        </aside>

        <div className="frame">
          <header className="topbar">
            <span className="topbar-title">
              {view === "mail" ? "Mail" : view === "calendar" ? "Calendar" : "Agent"}
            </span>
            <span className="topbar-spacer" />
            <UpgradePro />
            <button
              type="button"
              className="icon-btn"
              data-tip="Keyboard shortcuts — ?"
              data-tip-pos="down"
              aria-label="Keyboard shortcuts"
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
            {view === "calendar" && (
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
                {view === "agent" ? (
                  <AgentPanel />
                ) : view === "mail" ? (
                  <GmailPanel
                    view={mailView}
                    onViewChange={setMailView}
                    composeOpen={composeOpen}
                    onComposeOpenChange={setComposeOpen}
                    account={activeAccount}
                    autoSync={!firstRun}
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
                    account={activeAccount}
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
        onAddAccount={addAccount}
        accounts={accountList.map((a) => ({ id: a.id, email: a.email }))}
        onSwitchAccount={pickAccount}
      />
      <ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />
      {firstRun && <FirstSyncVeil onEnter={() => setFirstRun(false)} />}
      <AnimatePresence>
        {chordPending && (
          <motion.div
            className="chord-chip"
            variants={chordBar}
            initial="initial"
            animate="animate"
            exit="exit"
            role="status"
          >
            <span className="chord-inner">
              <Kbd>G</Kbd>
              <span className="chord-then">then</span>
              <span><Kbd>I</Kbd> inbox</span>
              <span><Kbd>U</Kbd> priority</span>
              <span><Kbd>S</Kbd> starred</span>
              <span><Kbd>A</Kbd> archive</span>
              <span><Kbd>P</Kbd> spam</span>
              <span><Kbd>T</Kbd> trash</span>
              <span><Kbd>D</Kbd> drafts</span>
              <span><Kbd>C</Kbd> calendar</span>
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}
