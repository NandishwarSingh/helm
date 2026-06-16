import { describe, expect, it } from "vitest";

import {
  HOUR_PX,
  isAllDay,
  layoutDay,
  minutesIntoDay,
  shiftDateString,
} from "@/lib/calendar";

describe("isAllDay", () => {
  it("is true for date-only starts, false for datetimes", () => {
    expect(isAllDay({ start: "2026-06-12" })).toBe(true);
    expect(isAllDay({ start: "2026-06-12T09:00:00+05:30" })).toBe(false);
    expect(isAllDay({ start: "" })).toBe(false);
  });
});

describe("shiftDateString", () => {
  it("shifts whole days without timezone drift", () => {
    expect(shiftDateString("2026-06-12", 1)).toBe("2026-06-13");
    expect(shiftDateString("2026-06-12", -1)).toBe("2026-06-11");
  });
  it("rolls across month and year boundaries", () => {
    expect(shiftDateString("2026-06-30", 1)).toBe("2026-07-01");
    expect(shiftDateString("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDateString("2026-01-01", -1)).toBe("2025-12-31");
  });
  it("returns the input unchanged when malformed", () => {
    expect(shiftDateString("not-a-date", 1)).toBe("not-a-date");
  });
});

describe("minutesIntoDay", () => {
  it("returns local minutes from midnight", () => {
    const d = new Date(2026, 5, 12, 9, 30);
    expect(minutesIntoDay(d.toISOString())).toBe(9 * 60 + 30);
  });
});

describe("layoutDay", () => {
  const ev = (id: string, start: string, end: string) => ({ id, start, end });
  const iso = (h: number, m = 0) =>
    new Date(2026, 5, 12, h, m).toISOString();

  it("gives a single non-overlapping event one full-width lane", () => {
    const [pos] = layoutDay([ev("a", iso(9), iso(10))]);
    expect(pos!.lanes).toBe(1);
    expect(pos!.lane).toBe(0);
    expect(pos!.height).toBe(HOUR_PX); // one hour
  });

  it("splits two overlapping events into two lanes", () => {
    const out = layoutDay([
      ev("a", iso(9), iso(11)),
      ev("b", iso(10), iso(12)),
    ]);
    expect(out.every((p) => p.lanes === 2)).toBe(true);
    expect(new Set(out.map((p) => p.lane))).toEqual(new Set([0, 1]));
  });

  it("reuses a lane once the earlier event has ended", () => {
    const out = layoutDay([
      ev("a", iso(9), iso(10)),
      ev("b", iso(11), iso(12)),
    ]);
    expect(out.every((p) => p.lanes === 1)).toBe(true);
  });

  it("enforces a minimum height for very short events", () => {
    const [pos] = layoutDay([ev("a", iso(9), iso(9, 5))]);
    expect(pos!.height).toBeGreaterThanOrEqual(22);
  });
});
