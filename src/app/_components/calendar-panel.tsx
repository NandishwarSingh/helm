"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  MapPinIcon,
  RefreshIcon,
} from "@/components/icons";
import { HelmLoader } from "@/components/helm-loader";
import { Kbd } from "@/components/kbd";
import { hasOverlay, isTypingTarget, useAction } from "@/lib/actions";
import {
  formatAttendees,
  formatEventWhen,
  LinkifiedText,
} from "@/lib/display";
import { listRow, scrim, slideOver } from "@/lib/motion";
import { formatWeekLabel, getWeekBounds } from "@/lib/week";
import { api } from "@/trpc/react";

type Props = {
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
};

function toDatetimeLocalValue(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dayLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

export function CalendarPanel({ createOpen, onCreateOpenChange }: Props) {
  const [search, setSearch] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [weekOffset, setWeekOffset] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  const week = useMemo(() => getWeekBounds(weekOffset), [weekOffset]);
  const weekLabel = formatWeekLabel(week.start, week.end);

  const defaultStart = new Date();
  defaultStart.setMinutes(0, 0, 0);
  const defaultEnd = new Date(defaultStart);
  defaultEnd.setHours(defaultEnd.getHours() + 1);

  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [start, setStart] = useState(toDatetimeLocalValue(defaultStart));
  const [end, setEnd] = useState(toDatetimeLocalValue(defaultEnd));
  const [attendees, setAttendees] = useState("");

  const utils = api.useUtils();

  const events = api.calendar.searchEvents.useQuery({
    query: activeSearch,
    weekStart: week.start.toISOString(),
    weekEnd: week.end.toISOString(),
    limit: 50,
    offset: 0,
  });

  const refreshEvents = api.calendar.refreshEvents.useMutation({
    onSuccess: async () => {
      await utils.calendar.searchEvents.invalidate();
    },
  });

  function resetForm() {
    setSummary("");
    setDescription("");
    setLocation("");
    setAttendees("");
  }

  const createDraft = api.calendar.createDraft.useMutation({
    onSuccess: async () => {
      await utils.calendar.searchEvents.invalidate();
      resetForm();
      onCreateOpenChange(false);
    },
  });

  const sendInvite = api.calendar.sendInvite.useMutation({
    onSuccess: async () => {
      await utils.calendar.searchEvents.invalidate();
      resetForm();
      onCreateOpenChange(false);
    },
  });

  // Warm each week once when it loads with no cached events.
  const syncedWeeks = useRef(new Set<string>());
  useEffect(() => {
    const key = week.start.toISOString();
    if (syncedWeeks.current.has(key)) return;
    if (events.isLoading || !events.data || events.data.length > 0) return;
    syncedWeeks.current.add(key);
    refreshEvents.mutate({ weekStart: key, weekEnd: week.end.toISOString() });
  }, [events.data, events.isLoading, week.start, week.end, refreshEvents]);

  // Close the create panel on Escape.
  useEffect(() => {
    if (!createOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCreateOpenChange(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [createOpen, onCreateOpenChange]);

  // Calendar keyboard layer: week navigation and today.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) {
        if (event.key === "Escape" && event.target === searchRef.current) {
          setSearch(activeSearch);
          searchRef.current?.blur();
        }
        return;
      }
      if (hasOverlay()) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.key) {
        case "h":
        case "ArrowLeft":
          setWeekOffset((w) => w - 1);
          break;
        case "l":
        case "ArrowRight":
          setWeekOffset((w) => w + 1);
          break;
        case "t":
          setWeekOffset(0);
          break;
        default:
          return;
      }
      event.preventDefault();
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeSearch]);

  // Palette / global-shortcut hooks.
  useAction("focus-search", () => {
    searchRef.current?.focus();
    searchRef.current?.select();
  });
  useAction("refresh", () => {
    if (refreshEvents.isPending) return;
    refreshEvents.mutate({
      weekStart: week.start.toISOString(),
      weekEnd: week.end.toISOString(),
    });
  });

  function parseAttendees() {
    return attendees
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
  }

  const eventInput = {
    summary,
    description: description || undefined,
    location: location || undefined,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    attendees: parseAttendees(),
  };

  const grouped = useMemo(() => {
    const list = events.data ?? [];
    const groups = new Map<string, typeof list>();
    for (const event of list) {
      const label = dayLabel(event.start) || "Scheduled";
      const existing = groups.get(label) ?? [];
      existing.push(event);
      groups.set(label, existing);
    }
    return Array.from(groups.entries());
  }, [events.data]);

  const createError = createDraft.error ?? sendInvite.error;
  const canCreate = Boolean(summary && start && end);

  return (
    <div className="cal">
      <div className="cal-head">
        <button
          type="button"
          className="icon-btn"
          onClick={() => setWeekOffset((w) => w - 1)}
          aria-label="Previous week"
        >
          <ChevronLeftIcon size={16} />
        </button>
        <span className="cal-weeklabel tnum">{weekLabel}</span>
        <button
          type="button"
          className="icon-btn"
          onClick={() => setWeekOffset((w) => w + 1)}
          aria-label="Next week"
        >
          <ChevronRightIcon size={16} />
        </button>
        {weekOffset !== 0 && (
          <button
            type="button"
            className="btn"
            onClick={() => setWeekOffset(0)}
          >
            Today
          </button>
        )}
        <span className="topbar-spacer" />
        <button
          type="button"
          className="icon-btn"
          title="Refresh from Calendar"
          data-spinning={refreshEvents.isPending}
          onClick={() =>
            refreshEvents.mutate({
              weekStart: week.start.toISOString(),
              weekEnd: week.end.toISOString(),
            })
          }
          disabled={refreshEvents.isPending}
        >
          <RefreshIcon size={15} />
        </button>
      </div>

      <form
        className="cal-search"
        onSubmit={(e) => {
          e.preventDefault();
          setActiveSearch(search);
        }}
      >
        <div className="search-wrap">
          <input
            ref={searchRef}
            className="field"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search events"
          />
          <Kbd>/</Kbd>
        </div>
      </form>

      <div className="cal-body">
        {events.isLoading && (
          <div className="empty">
            <HelmLoader size={40} />
          </div>
        )}
        {events.error && <p className="error">{events.error.message}</p>}
        {events.data?.length === 0 && (
          <div className="empty">
            <p>No events this week.</p>
            <p className="tnum">N to schedule one · H / L to change week</p>
          </div>
        )}

        {grouped.length > 0 && (
          <div className="cal-list">
            {grouped.map(([label, dayEvents]) => (
              <section className="cal-day" key={label}>
                <h2 className="cal-day-label">{label}</h2>
                {(dayEvents ?? []).map((event, i) => (
              <motion.article
                className="event-row"
                key={event.id}
                variants={listRow}
                initial="initial"
                animate="animate"
                custom={i}
              >
                <div className="event-when tnum">
                  {formatEventWhen(event.start, event.end)}
                </div>
                <div className="event-main">
                  <div className="event-title">
                    {event.htmlLink ? (
                      <a
                        href={event.htmlLink}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {event.summary || "Untitled event"}
                      </a>
                    ) : (
                      (event.summary ?? "Untitled event")
                    )}
                  </div>
                  {event.location && (
                    <div className="event-meta">
                      <MapPinIcon size={13} />
                      {event.location}
                    </div>
                  )}
                  {event.attendees.length > 0 && (
                    <div className="event-meta">
                      {formatAttendees(event.attendees)}
                    </div>
                  )}
                  {event.description && (
                    <div className="event-desc">
                      <LinkifiedText text={event.description} />
                    </div>
                  )}
                </div>
              </motion.article>
            ))}
              </section>
            ))}
          </div>
        )}
      </div>

      <AnimatePresence>
        {createOpen && (
          <>
            <motion.div
              className="scrim"
              variants={scrim}
              initial="initial"
              animate="animate"
              exit="exit"
              onClick={() => onCreateOpenChange(false)}
            />
            <motion.div
              className="compose"
              variants={slideOver}
              initial="initial"
              animate="animate"
              exit="exit"
              role="dialog"
              aria-label="New event"
              onKeyDown={(event) => {
                if (!(event.metaKey || event.ctrlKey)) return;
                if (event.key !== "Enter" || !canCreate) return;
                event.preventDefault();
                if (parseAttendees().length > 0 && !sendInvite.isPending) {
                  sendInvite.mutate(eventInput);
                } else if (!createDraft.isPending) {
                  createDraft.mutate(eventInput);
                }
              }}
            >
              <div className="compose-head">
                New event
                <span className="topbar-spacer" />
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => onCreateOpenChange(false)}
                  aria-label="Close"
                >
                  <CloseIcon size={16} />
                </button>
              </div>
              <div className="compose-body">
                <input
                  className="field"
                  type="text"
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  placeholder="Title"
                />
                <div className="field-row">
                  <label className="label">
                    Start
                    <input
                      className="field"
                      type="datetime-local"
                      value={start}
                      onChange={(e) => setStart(e.target.value)}
                    />
                  </label>
                  <label className="label">
                    End
                    <input
                      className="field"
                      type="datetime-local"
                      value={end}
                      onChange={(e) => setEnd(e.target.value)}
                    />
                  </label>
                </div>
                <input
                  className="field"
                  type="text"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="Location"
                />
                <input
                  className="field"
                  type="text"
                  value={attendees}
                  onChange={(e) => setAttendees(e.target.value)}
                  placeholder="Attendees (comma-separated emails)"
                />
                <textarea
                  className="field"
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Description"
                />
                {createError && <p className="error">{createError.message}</p>}
              </div>
              <div className="compose-foot">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => sendInvite.mutate(eventInput)}
                  disabled={
                    sendInvite.isPending ||
                    !canCreate ||
                    parseAttendees().length === 0
                  }
                >
                  {sendInvite.isPending ? "Sending…" : "Send invite"}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => createDraft.mutate(eventInput)}
                  disabled={createDraft.isPending || !canCreate}
                >
                  {createDraft.isPending ? "Saving…" : "Save draft"}
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
