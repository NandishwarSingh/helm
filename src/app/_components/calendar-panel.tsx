"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import type { EventSeed } from "@/app/_components/gmail-panel";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  RefreshIcon,
} from "@/components/icons";
import { HelmLoader } from "@/components/helm-loader";
import { Kbd } from "@/components/kbd";
import { hasOverlay, isTypingTarget, useAction, useOverlay } from "@/lib/actions";
import { parseEmailAddress } from "@/lib/display";
import { scrim, slideOver } from "@/lib/motion";
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

/** Geometry of the week grid. */
const HOUR_PX = 48;
const DAY_MINUTES = 24 * 60;

function toDatetimeLocalValue(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dayKey(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Date-only strings are calendar dates, not instants — parse and shift them
// in LOCAL time so the day never drifts across timezones.
function shiftDateString(value: string, days: number): string {
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return value;
  return dayKey(new Date(y, m - 1, d + days));
}

/** Date-only starts ("2026-06-12") are all-day events. */
function isAllDay(event: EventItem) {
  return Boolean(event.start) && !event.start.includes("T");
}

function minutesIntoDay(iso: string) {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

function formatHour(hour: number) {
  if (hour === 0) return "12 AM";
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return "12 PM";
  return `${hour - 12} PM`;
}

function formatTimeRange(event: EventItem) {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  return `${fmt(event.start)} – ${fmt(event.end)}`;
}

type Positioned = {
  event: EventItem;
  top: number;
  height: number;
  lane: number;
  lanes: number;
};

/**
 * Lays out one day's timed events: overlapping events split the column into
 * equal lanes (greedy first-free-lane assignment per overlap cluster).
 */
function layoutDay(events: EventItem[]): Positioned[] {
  const sorted = [...events].sort(
    (a, b) => minutesIntoDay(a.start) - minutesIntoDay(b.start),
  );
  const out: Positioned[] = [];
  let cluster: { item: EventItem; start: number; end: number; lane: number }[] =
    [];
  let clusterEnd = -1;

  const flush = () => {
    if (cluster.length === 0) return;
    const lanes = Math.max(...cluster.map((c) => c.lane)) + 1;
    for (const c of cluster) {
      const top = (c.start / DAY_MINUTES) * 24 * HOUR_PX;
      const height = Math.max(((c.end - c.start) / 60) * HOUR_PX, 22);
      out.push({ event: c.item, top, height, lane: c.lane, lanes });
    }
    cluster = [];
    clusterEnd = -1;
  };

  for (const item of sorted) {
    const start = minutesIntoDay(item.start);
    const end = Math.max(
      item.end?.includes("T") ? minutesIntoDay(item.end) : start + 30,
      start + 20,
    );
    if (cluster.length > 0 && start >= clusterEnd) flush();
    // First lane whose previous occupant has ended.
    const laneEnds: number[] = [];
    for (const c of cluster) {
      laneEnds[c.lane] = Math.max(laneEnds[c.lane] ?? 0, c.end);
    }
    let lane = 0;
    while ((laneEnds[lane] ?? 0) > start) lane += 1;
    cluster.push({ item, start, end, lane });
    clusterEnd = Math.max(clusterEnd, end);
  }
  flush();
  return out;
}

/** The accent line marking the current minute in today's column. */
function NowLine() {
  const [minutes, setMinutes] = useState(
    () => new Date().getHours() * 60 + new Date().getMinutes(),
  );
  useEffect(() => {
    const id = window.setInterval(() => {
      const now = new Date();
      setMinutes(now.getHours() * 60 + now.getMinutes());
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div
      className="calgrid-now"
      style={{ top: (minutes / DAY_MINUTES) * 24 * HOUR_PX }}
    >
      <span className="calgrid-now-dot" />
    </div>
  );
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
  const gridRef = useRef<HTMLDivElement>(null);

  const week = useMemo(() => getWeekBounds(weekOffset), [weekOffset]);
  const weekLabel = formatWeekLabel(week.start, week.end);

  // Roving event selection (J/K) and the delete confirmation.
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [confirmEvent, setConfirmEvent] = useState<EventItem | null>(null);

  // Dialog state: create or edit one event.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const defaults = (() => {
    const startAt = new Date();
    startAt.setMinutes(0, 0, 0);
    startAt.setHours(startAt.getHours() + 1);
    const endAt = new Date(startAt);
    endAt.setHours(endAt.getHours() + 1);
    return { startAt, endAt };
  })();
  const [start, setStart] = useState(toDatetimeLocalValue(defaults.startAt));
  const [end, setEnd] = useState(toDatetimeLocalValue(defaults.endAt));
  // All-day mode: start/end hold YYYY-MM-DD (end inclusive, for humans).
  const [allDay, setAllDay] = useState(false);
  const [attendees, setAttendees] = useState("");

  const dialogOpen = createOpen || editingId !== null;
  useOverlay(confirmEvent !== null);

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
    setAllDay(false);
    setStart(toDatetimeLocalValue(defaults.startAt));
    setEnd(toDatetimeLocalValue(defaults.endAt));
    setEditingId(null);
    setConfirmingDelete(false);
    setConfirmEvent(null);
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

  function openEdit(event: EventItem) {
    setEditingId(event.id);
    setConfirmingDelete(false);
    setSummary(event.summary);
    setDescription(event.description);
    setLocation(event.location);
    if (isAllDay(event)) {
      // Google stores the end date exclusive; people read it inclusive.
      setAllDay(true);
      setStart(event.start);
      setEnd(event.end ? shiftDateString(event.end, -1) : event.start);
    } else {
      setAllDay(false);
      setStart(toDatetimeLocalValue(new Date(event.start)));
      setEnd(toDatetimeLocalValue(new Date(event.end)));
    }
    setAttendees(
      event.attendees
        .map((a) => parseEmailAddress(a).email)
        .filter(Boolean)
        .join(", "),
    );
  }

  /** Quick add at a specific day and time (slot click / header click). */
  function openCreateAt(day: Date, hour = 9, minute = 0) {
    const startAt = new Date(day);
    startAt.setHours(hour, minute, 0, 0);
    const endAt = new Date(startAt);
    endAt.setMinutes(endAt.getMinutes() + 60);
    setAllDay(false);
    setStart(toDatetimeLocalValue(startAt));
    setEnd(toDatetimeLocalValue(endAt));
    onCreateOpenChange(true);
  }

  /** Quick add an all-day event (all-day lane click). */
  function openCreateAllDay(day: Date) {
    setAllDay(true);
    setStart(dayKey(day));
    setEnd(dayKey(day));
    onCreateOpenChange(true);
  }

  /** Flip the dialog between timed and all-day, carrying the dates over. */
  function toggleAllDay(next: boolean) {
    setAllDay(next);
    if (next) {
      setStart(start.slice(0, 10));
      setEnd(end.slice(0, 10) || start.slice(0, 10));
    } else {
      setStart(`${start.slice(0, 10)}T09:00`);
      setEnd(`${(end || start).slice(0, 10)}T10:00`);
    }
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

  // Scroll the grid to the working morning on mount and week change.
  useEffect(() => {
    const el = gridRef.current;
    if (el) el.scrollTop = 7.5 * HOUR_PX;
  }, [weekOffset, events.isLoading]);

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

  // Delete-confirm keys: Enter confirms, Escape cancels.
  useEffect(() => {
    if (!confirmEvent) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setConfirmEvent(null);
      } else if (event.key === "Enter") {
        event.preventDefault();
        deleteEvent.mutate({
          id: confirmEvent!.id,
          notify: confirmEvent!.attendees.length > 0,
        });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmEvent]);

  // The week, day by day, with timed events positioned.
  const days = useMemo(() => {
    const byDay = new Map<string, EventItem[]>();
    for (const event of events.data ?? []) {
      if (!event.start) continue;
      const key = isAllDay(event) ? event.start : dayKey(new Date(event.start));
      const list = byDay.get(key) ?? [];
      list.push(event);
      byDay.set(key, list);
    }
    const today = dayKey(new Date());
    return Array.from({ length: 7 }, (_, i) => {
      const date = new Date(week.start);
      date.setDate(date.getDate() + i);
      const key = dayKey(date);
      const all = byDay.get(key) ?? [];
      return {
        date,
        key,
        isToday: key === today,
        allDay: all.filter(isAllDay),
        timed: layoutDay(all.filter((e) => !isAllDay(e))),
      };
    });
  }, [events.data, week.start]);

  const hasAllDayLane = days.some((d) => d.allDay.length > 0);

  // Events in chronological order for J/K navigation.
  const orderedEvents = useMemo(
    () =>
      days.flatMap((day) => [...day.allDay, ...day.timed.map((p) => p.event)]),
    [days],
  );

  function moveEventSelection(step: 1 | -1) {
    if (orderedEvents.length === 0) return;
    const index = orderedEvents.findIndex((ev) => ev.id === selectedEventId);
    const next =
      index === -1
        ? 0
        : Math.min(Math.max(index + step, 0), orderedEvents.length - 1);
    const target = orderedEvents[next];
    if (!target) return;
    setSelectedEventId(target.id);
    document
      .querySelector(`[data-event-id="${target.id}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  // Calendar keyboard layer.
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
          setSelectedEventId(null);
          break;
        case "l":
        case "ArrowRight":
          setWeekOffset((w) => w + 1);
          setSelectedEventId(null);
          break;
        case "t":
          setWeekOffset(0);
          setSelectedEventId(null);
          break;
        case "j":
        case "ArrowDown":
          moveEventSelection(1);
          break;
        case "k":
        case "ArrowUp":
          moveEventSelection(-1);
          break;
        case "Enter":
        case "e": {
          const target = orderedEvents.find((ev) => ev.id === selectedEventId);
          if (!target) return;
          openEdit(target);
          break;
        }
        case "#": {
          const target = orderedEvents.find((ev) => ev.id === selectedEventId);
          if (!target) return;
          setConfirmEvent(target);
          break;
        }
        case "Escape":
          if (!selectedEventId) return;
          setSelectedEventId(null);
          break;
        default:
          return;
      }
      event.preventDefault();
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

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
    allDay,
    // All-day sends calendar dates (end exclusive again); timed sends instants.
    start: allDay ? start : new Date(start).toISOString(),
    end: allDay ? shiftDateString(end, 1) : new Date(end).toISOString(),
    attendees: parseAttendees(),
  };

  const canSubmit = Boolean(summary && start && end);
  const dialogBusy =
    createDraft.isPending ||
    sendInvite.isPending ||
    updateEvent.isPending ||
    deleteEvent.isPending;
  const dialogError =
    createDraft.error ??
    sendInvite.error ??
    updateEvent.error ??
    deleteEvent.error;

  function submitPrimary() {
    if (!canSubmit || dialogBusy) return;
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

  function onSlotClick(day: Date, offsetY: number) {
    const minutes = Math.floor(((offsetY / HOUR_PX) * 60) / 30) * 30;
    const clamped = Math.min(Math.max(minutes, 0), DAY_MINUTES - 60);
    openCreateAt(day, Math.floor(clamped / 60), clamped % 60);
  }

  return (
    <div className="cal">
      <div className="cal-head">
        <button
          type="button"
          className="icon-btn"
          onClick={() => {
            setWeekOffset((w) => w - 1);
            setSelectedEventId(null);
          }}
          aria-label="Previous week"
        >
          <ChevronLeftIcon size={16} />
        </button>
        <span className="cal-weeklabel tnum">{weekLabel}</span>
        <button
          type="button"
          className="icon-btn"
          onClick={() => {
            setWeekOffset((w) => w + 1);
            setSelectedEventId(null);
          }}
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
        <div className="cal-search search-wrap">
          <input
            ref={searchRef}
            className="field"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                setActiveSearch(search);
                searchRef.current?.blur();
              }
            }}
            placeholder="Search events"
          />
          <Kbd>/</Kbd>
        </div>
        <span className="topbar-spacer" />
        <button
          type="button"
          className="icon-btn"
          data-tip="Refresh from Calendar"
          data-tip-pos="down"
          aria-label="Refresh from Calendar"
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

      {events.isLoading ? (
        <div className="empty" style={{ flex: 1 }}>
          <HelmLoader size={40} />
        </div>
      ) : events.error ? (
        <p className="error" style={{ padding: "1rem 1.2rem" }}>
          {events.error.message}
        </p>
      ) : (
        <div className="calgrid" ref={gridRef}>
          <div className="calgrid-head">
            <span className="calgrid-corner" />
            {days.map((day) => (
              <button
                key={day.key}
                type="button"
                className="calgrid-dayhead"
                data-today={day.isToday}
                data-tip="Add an event on this day"
                data-tip-pos="down"
                onClick={() => openCreateAt(day.date)}
              >
                <span className="calgrid-dayname">
                  {day.date.toLocaleDateString("en-US", { weekday: "short" })}
                </span>
                <span className="calgrid-daynum tnum">
                  {day.date.getDate()}
                </span>
              </button>
            ))}
          </div>

          {hasAllDayLane && (
            <div className="calgrid-allday">
              <span className="calgrid-gutterlabel tnum">all-day</span>
              {days.map((day) => (
                <div
                  className="calgrid-alldaycell"
                  key={day.key}
                  onClick={() => openCreateAllDay(day.date)}
                >
                  {day.allDay.map((event) => (
                    <button
                      key={event.id}
                      type="button"
                      className="calgrid-alldaychip"
                      data-active={selectedEventId === event.id}
                      data-event-id={event.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedEventId(event.id);
                        openEdit(event);
                      }}
                    >
                      {event.summary || "Untitled"}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}

          <div className="calgrid-body">
            <div className="calgrid-gutter">
              {Array.from({ length: 24 }, (_, hour) => (
                <span
                  key={hour}
                  className="calgrid-hourlabel tnum"
                  style={{ top: hour * HOUR_PX }}
                >
                  {hour === 0 ? "" : formatHour(hour)}
                </span>
              ))}
            </div>
            {days.map((day) => (
              <div
                key={day.key}
                className="calgrid-col"
                data-today={day.isToday}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  onSlotClick(day.date, e.clientY - rect.top);
                }}
              >
                {Array.from({ length: 23 }, (_, i) => (
                  <span
                    key={i}
                    className="calgrid-hourline"
                    style={{ top: (i + 1) * HOUR_PX }}
                  />
                ))}
                {day.isToday && <NowLine />}
                {day.timed.map(({ event, top, height, lane, lanes }) => (
                  <button
                    key={event.id}
                    type="button"
                    className="calgrid-event"
                    data-active={selectedEventId === event.id}
                    data-event-id={event.id}
                    style={{
                      top,
                      height,
                      left: `calc(${(lane / lanes) * 100}% + 2px)`,
                      width: `calc(${100 / lanes}% - 5px)`,
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedEventId(event.id);
                      openEdit(event);
                    }}
                  >
                    <span className="calgrid-event-title">
                      {event.summary || "Untitled"}
                    </span>
                    {height >= 40 && (
                      <span className="calgrid-event-time tnum">
                        {formatTimeRange(event)}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <AnimatePresence>
        {confirmEvent && (
          <>
            <motion.div
              className="scrim"
              variants={scrim}
              initial="initial"
              animate="animate"
              exit="exit"
              onClick={() => setConfirmEvent(null)}
            />
            <motion.div
              className="confirm"
              variants={slideOver}
              initial="initial"
              animate="animate"
              exit="exit"
              role="alertdialog"
              aria-label="Confirm delete"
            >
              <div className="confirm-body">
                <h2 className="confirm-title">
                  Delete &quot;{confirmEvent.summary || "Untitled event"}&quot;?
                </h2>
                <p className="confirm-text">
                  {confirmEvent.attendees.length > 0
                    ? "Attendees will be notified that the event is cancelled."
                    : "This cannot be undone."}
                </p>
              </div>
              <div className="confirm-foot">
                <button
                  type="button"
                  className="btn"
                  onClick={() => setConfirmEvent(null)}
                >
                  Cancel
                  <Kbd>esc</Kbd>
                </button>
                <button
                  type="button"
                  className="btn btn-danger-solid"
                  onClick={() =>
                    deleteEvent.mutate({
                      id: confirmEvent.id,
                      notify: confirmEvent.attendees.length > 0,
                    })
                  }
                  disabled={deleteEvent.isPending}
                >
                  Delete event
                  <Kbd>↵</Kbd>
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

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
                      type={allDay ? "date" : "datetime-local"}
                      value={start}
                      onChange={(e) => setStart(e.target.value)}
                    />
                  </label>
                  <label className="label">
                    End
                    <input
                      className="field"
                      type={allDay ? "date" : "datetime-local"}
                      value={end}
                      onChange={(e) => setEnd(e.target.value)}
                    />
                  </label>
                </div>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={allDay}
                    onChange={(e) => toggleAllDay(e.target.checked)}
                  />
                  All day
                </label>
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
