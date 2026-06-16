"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import type { EventSeed } from "@/app/_components/gmail-panel";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  MapPinIcon,
  PlusIcon,
  RefreshIcon,
} from "@/components/icons";
import { HelmLoader } from "@/components/helm-loader";
import { Kbd } from "@/components/kbd";
import { hasOverlay, isTypingTarget, useAction } from "@/lib/actions";
import {
  formatAttendees,
  formatEventWhen,
  LinkifiedText,
  parseEmailAddress,
} from "@/lib/display";
import { listRow, scrim, slideOver } from "@/lib/motion";
import { formatWeekLabel, getWeekBounds } from "@/lib/week";
import { api } from "@/trpc/react";

type Props = {
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
  seed: EventSeed | null;
  onSeedConsumed: () => void;
};

type EventItem = {
  id: string;
  summary: string;
  description: string;
  location: string;
  start: string;
  end: string;
  attendees: string[];
  htmlLink: string;
};

function toDatetimeLocalValue(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dayKey(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Next round hour (defaults for the create dialog). */
function nextHour() {
  const start = new Date();
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 1);
  const end = new Date(start);
  end.setHours(end.getHours() + 1);
  return { start, end };
}

export function CalendarPanel({
  createOpen,
  onCreateOpenChange,
  seed,
  onSeedConsumed,
}: Props) {
  const [search, setSearch] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [weekOffset, setWeekOffset] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  const week = useMemo(() => getWeekBounds(weekOffset), [weekOffset]);
  const weekLabel = formatWeekLabel(week.start, week.end);

  // Dialog state: create or edit one event.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const defaults = nextHour();
  const [start, setStart] = useState(toDatetimeLocalValue(defaults.start));
  const [end, setEnd] = useState(toDatetimeLocalValue(defaults.end));
  const [attendees, setAttendees] = useState("");

  const dialogOpen = createOpen || editingId !== null;

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

  function closeDialog() {
    setSummary("");
    setDescription("");
    setLocation("");
    setAttendees("");
    setEditingId(null);
    setConfirmingDelete(false);
    onCreateOpenChange(false);
  }

  const createDraft = api.calendar.createDraft.useMutation({
    onSuccess: async () => {
      await utils.calendar.searchEvents.invalidate();
      closeDialog();
    },
  });

  const sendInvite = api.calendar.sendInvite.useMutation({
    onSuccess: async () => {
      await utils.calendar.searchEvents.invalidate();
      closeDialog();
    },
  });

  const updateEvent = api.calendar.updateEvent.useMutation({
    onSuccess: async () => {
      await utils.calendar.searchEvents.invalidate();
      closeDialog();
    },
  });

  const deleteEvent = api.calendar.deleteEvent.useMutation({
    onSuccess: async () => {
      await utils.calendar.searchEvents.invalidate();
      closeDialog();
    },
  });

  // Consume an email-to-calendar seed when the dialog opens for it.
  useEffect(() => {
    if (!createOpen || !seed) return;
    setSummary(seed.summary);
    setAttendees(seed.attendee);
    setDescription(seed.description);
    onSeedConsumed();
  }, [createOpen, seed, onSeedConsumed]);

  // Edit: prefill the dialog from an existing event.
  function openEdit(event: EventItem) {
    setEditingId(event.id);
    setConfirmingDelete(false);
    setSummary(event.summary);
    setDescription(event.description);
    setLocation(event.location);
    if (event.start) setStart(toDatetimeLocalValue(new Date(event.start)));
    if (event.end) setEnd(toDatetimeLocalValue(new Date(event.end)));
    setAttendees(
      event.attendees
        .map((a) => parseEmailAddress(a).email)
        .filter(Boolean)
        .join(", "),
    );
  }

  // Quick add: a specific day at 09:00.
  function openCreateForDay(day: Date) {
    const startAt = new Date(day);
    startAt.setHours(9, 0, 0, 0);
    const endAt = new Date(startAt);
    endAt.setHours(10);
    setStart(toDatetimeLocalValue(startAt));
    setEnd(toDatetimeLocalValue(endAt));
    onCreateOpenChange(true);
  }

  // Warm each week once when it loads with no cached events.
  const syncedWeeks = useRef(new Set<string>());
  useEffect(() => {
    const key = week.start.toISOString();
    if (syncedWeeks.current.has(key)) return;
    if (events.isLoading || !events.data || events.data.length > 0) return;
    syncedWeeks.current.add(key);
    refreshEvents.mutate({ weekStart: key, weekEnd: week.end.toISOString() });
  }, [events.data, events.isLoading, week.start, week.end, refreshEvents]);

  // Close the dialog on Escape.
  useEffect(() => {
    if (!dialogOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeDialog();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOpen]);

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

  function submitPrimary() {
    if (!canSubmit) return;
    if (editingId) {
      updateEvent.mutate({
        id: editingId,
        ...eventInput,
        attendees: parseAttendees(),
        notify: parseAttendees().length > 0,
      });
    } else if (parseAttendees().length > 0) {
      sendInvite.mutate(eventInput);
    } else {
      createDraft.mutate(eventInput);
    }
  }

  // The week, day by day, with that day's events attached.
  const days = useMemo(() => {
    const byDay = new Map<string, EventItem[]>();
    for (const event of events.data ?? []) {
      if (!event.start) continue;
      const key = dayKey(new Date(event.start));
      const list = byDay.get(key) ?? [];
      list.push(event);
      byDay.set(key, list);
    }
    const today = dayKey(new Date());
    return Array.from({ length: 7 }, (_, i) => {
      const date = new Date(week.start);
      date.setDate(date.getDate() + i);
      const key = dayKey(date);
      return {
        date,
        key,
        isToday: key === today,
        events: byDay.get(key) ?? [],
      };
    });
  }, [events.data, week.start]);

  const dialogError =
    createDraft.error ??
    sendInvite.error ??
    updateEvent.error ??
    deleteEvent.error;
  const dialogBusy =
    createDraft.isPending ||
    sendInvite.isPending ||
    updateEvent.isPending ||
    deleteEvent.isPending;
  const canSubmit = Boolean(summary && start && end);

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
          <button type="button" className="btn" onClick={() => setWeekOffset(0)}>
            Today
            <Kbd>T</Kbd>
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

      <div className="cal-strip">
        {days.map((day) => (
          <button
            key={day.key}
            type="button"
            className="cal-strip-day"
            data-today={day.isToday}
            title="Add an event on this day"
            onClick={() => openCreateForDay(day.date)}
          >
            <span className="cal-strip-name">
              {day.date.toLocaleDateString("en-US", { weekday: "short" })}
            </span>
            <span className="cal-strip-num tnum">{day.date.getDate()}</span>
            <span className="cal-strip-count">
              {day.events.length > 0 ? day.events.length : ""}
            </span>
          </button>
        ))}
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

        {!events.isLoading && !events.error && (
          <div className="cal-list">
            {days.map((day) => (
              <section className="cal-day" key={day.key}>
                <div className="cal-day-head">
                  <h2 className="cal-day-label" data-today={day.isToday}>
                    {day.date.toLocaleDateString("en-US", {
                      weekday: "long",
                      month: "short",
                      day: "numeric",
                    })}
                    {day.isToday && <span className="cal-today-chip">Today</span>}
                  </h2>
                  <button
                    type="button"
                    className="icon-btn cal-day-add"
                    title="Add an event on this day"
                    onClick={() => openCreateForDay(day.date)}
                  >
                    <PlusIcon size={14} />
                  </button>
                </div>
                {day.events.length === 0 ? (
                  <p className="cal-day-empty">No events</p>
                ) : (
                  day.events.map((event, i) => (
                    <motion.article
                      className="event-row"
                      key={event.id}
                      variants={listRow}
                      initial="initial"
                      animate="animate"
                      custom={i}
                      onClick={() => openEdit(event)}
                      title="Edit event"
                    >
                      <div className="event-when tnum">
                        {formatEventWhen(event.start, event.end)}
                      </div>
                      <div className="event-main">
                        <div className="event-title">
                          {event.summary || "Untitled event"}
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
                  ))
                )}
              </section>
            ))}
          </div>
        )}
      </div>

      <AnimatePresence>
        {dialogOpen && (
          <>
            <motion.div
              className="scrim"
              variants={scrim}
              initial="initial"
              animate="animate"
              exit="exit"
              onClick={closeDialog}
            />
            <motion.div
              className="compose"
              variants={slideOver}
              initial="initial"
              animate="animate"
              exit="exit"
              role="dialog"
              aria-label={editingId ? "Edit event" : "New event"}
              onKeyDown={(event) => {
                if (!(event.metaKey || event.ctrlKey)) return;
                if (event.key !== "Enter" || dialogBusy) return;
                event.preventDefault();
                submitPrimary();
              }}
            >
              <div className="compose-head">
                {editingId ? "Edit event" : "New event"}
                <span className="topbar-spacer" />
                <button
                  type="button"
                  className="icon-btn"
                  onClick={closeDialog}
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
                {dialogError && <p className="error">{dialogError.message}</p>}
              </div>
              <div className="compose-foot">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={submitPrimary}
                  disabled={dialogBusy || !canSubmit}
                >
                  {dialogBusy
                    ? "Working…"
                    : editingId
                      ? "Save changes"
                      : parseAttendees().length > 0
                        ? "Send invite"
                        : "Create event"}
                  <Kbd>⌘↵</Kbd>
                </button>
                {!editingId && parseAttendees().length > 0 && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => createDraft.mutate(eventInput)}
                    disabled={dialogBusy || !canSubmit}
                  >
                    Save without sending
                  </button>
                )}
                {editingId && (
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() =>
                      confirmingDelete
                        ? deleteEvent.mutate({
                            id: editingId,
                            notify: parseAttendees().length > 0,
                          })
                        : setConfirmingDelete(true)
                    }
                    disabled={dialogBusy}
                  >
                    {confirmingDelete ? "Confirm delete" : "Delete"}
                  </button>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
