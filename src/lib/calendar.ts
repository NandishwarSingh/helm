/**
 * Pure calendar geometry and date helpers, shared by the week grid and its
 * tests. No React, no server imports — just maths on dates and event spans.
 */

/** Geometry of the week grid. */
export const HOUR_PX = 48;
export const DAY_MINUTES = 24 * 60;

export type TimedEvent = { id: string; start: string; end: string };

export type Positioned<T extends TimedEvent> = {
  event: T;
  top: number;
  height: number;
  lane: number;
  lanes: number;
};

const pad = (n: number) => String(n).padStart(2, "0");

/** A Date as the `datetime-local` input value (local wall-clock, no zone). */
export function toDatetimeLocalValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A Date as a YYYY-MM-DD calendar key in local time. */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Shift a YYYY-MM-DD string by whole days, staying in LOCAL time so the date
 * never drifts across timezones (Google all-day ends are exclusive, so the
 * dialog converts ±1 day here).
 */
export function shiftDateString(value: string, days: number): string {
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return value;
  return dayKey(new Date(y, m - 1, d + days));
}

/** Date-only starts ("2026-06-12") are all-day events. */
export function isAllDay(event: { start: string }): boolean {
  return Boolean(event.start) && !event.start.includes("T");
}

/** Minutes from local midnight for an ISO datetime. */
export function minutesIntoDay(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Lay out one day's timed events: overlapping events split the column into
 * equal lanes (greedy first-free-lane assignment per overlap cluster).
 */
export function layoutDay<T extends TimedEvent>(events: T[]): Positioned<T>[] {
  const sorted = [...events].sort(
    (a, b) => minutesIntoDay(a.start) - minutesIntoDay(b.start),
  );
  const out: Positioned<T>[] = [];
  let cluster: { item: T; start: number; end: number; lane: number }[] = [];
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
