import { describe, expect, test } from "bun:test";
import { rankByPaletteQuery } from "@/browser/utils/commandPaletteRanking";

describe("rankByPaletteQuery", () => {
  const items = [
    { name: "Show Output", section: "Navigation" },
    { name: "Toggle Layout", section: "Layouts" },
    { name: "Output Panel Settings", section: "Settings" },
  ];

  const toSearchText = (item: { name: string }) => item.name;
  const tieBreak = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

  test("exact match outranks weaker matches", () => {
    const result = rankByPaletteQuery({ items, query: "output", toSearchText, tieBreak });

    expect(result.map((item) => item.name)).toEqual(["Show Output", "Output Panel Settings"]);
  });

  test("no-match items are filtered out", () => {
    const result = rankByPaletteQuery({ items, query: "zzz", toSearchText, tieBreak });

    expect(result).toHaveLength(0);
  });

  test("empty query preserves tie-break ordering", () => {
    const result = rankByPaletteQuery({ items, query: "", toSearchText, tieBreak });

    expect(result.map((item) => item.name)).toEqual([
      "Output Panel Settings",
      "Show Output",
      "Toggle Layout",
    ]);
  });

  test("empty query with whitespace preserves tie-break ordering", () => {
    const result = rankByPaletteQuery({ items, query: "  ", toSearchText, tieBreak });

    expect(result.map((item) => item.name)).toEqual([
      "Output Panel Settings",
      "Show Output",
      "Toggle Layout",
    ]);
  });

  test("stable tie behavior for prompt-select options", () => {
    const options = [
      { label: "Alpha Model", idx: 0 },
      { label: "Alpha Provider", idx: 1 },
      { label: "Beta Model", idx: 2 },
    ];

    const result = rankByPaletteQuery({
      items: options,
      query: "alpha",
      toSearchText: (option) => option.label,
      tieBreak: (a, b) => a.idx - b.idx,
    });

    expect(result).toHaveLength(2);
    expect(result[0].label).toBe("Alpha Model");
    expect(result[1].label).toBe("Alpha Provider");
  });

  test("multi-term AND semantics", () => {
    const result = rankByPaletteQuery({ items, query: "output panel", toSearchText, tieBreak });

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Output Panel Settings");
  });
});
