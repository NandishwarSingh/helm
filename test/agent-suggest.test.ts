import { describe, expect, it } from "vitest";

import { parseSuggestions } from "@/server/lib/agent-suggest";

describe("parseSuggestions", () => {
  it("parses a clean JSON array", () => {
    expect(
      parseSuggestions(
        '[{"label":"A","prompt":"do a"},{"label":"B","prompt":"do b"}]',
      ),
    ).toEqual([
      { label: "A", prompt: "do a" },
      { label: "B", prompt: "do b" },
    ]);
  });

  it("slices the array out of surrounding prose", () => {
    expect(
      parseSuggestions('Sure: [{"label":"A","prompt":"do a"}] hope that helps'),
    ).toEqual([{ label: "A", prompt: "do a" }]);
  });

  it("caps at 4 even when the model returns more (M2)", () => {
    const items = Array.from({ length: 7 }, (_, i) => ({
      label: `L${i}`,
      prompt: `P${i}`,
    }));
    expect(parseSuggestions(JSON.stringify(items))).toHaveLength(4);
  });

  it("skips invalid items but keeps the valid ones", () => {
    expect(
      parseSuggestions(
        '[{"label":"ok","prompt":"p"},{"label":"","prompt":"p"},{"nope":1}]',
      ),
    ).toEqual([{ label: "ok", prompt: "p" }]);
  });

  it("returns [] on non-JSON and on non-array JSON", () => {
    expect(parseSuggestions("sorry, no ideas")).toEqual([]);
    expect(parseSuggestions('{"label":"A","prompt":"p"}')).toEqual([]);
  });

  it("drops items with an over-long label or prompt", () => {
    expect(
      parseSuggestions(JSON.stringify([{ label: "x".repeat(49), prompt: "p" }])),
    ).toEqual([]);
    expect(
      parseSuggestions(JSON.stringify([{ label: "ok", prompt: "y".repeat(161) }])),
    ).toEqual([]);
  });
});
