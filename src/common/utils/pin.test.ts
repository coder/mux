import { describe, expect, it } from "bun:test";

import { comparePinnedOrder, reassignPinnedTimestamps, recomposePinnedOrder } from "./pin";

describe("comparePinnedOrder", () => {
  it("sorts by pinnedAt ascending with id tie-break", () => {
    const rows = [
      { id: "b", pinnedAt: "2026-01-01T00:00:02.000Z" },
      { id: "c", pinnedAt: "2026-01-01T00:00:01.000Z" },
      { id: "a", pinnedAt: "2026-01-01T00:00:01.000Z" },
    ];
    expect(rows.sort(comparePinnedOrder).map((row) => row.id)).toEqual(["a", "c", "b"]);
  });

  it("treats unparseable pinnedAt as earliest", () => {
    const rows = [
      { id: "b", pinnedAt: "2026-01-01T00:00:01.000Z" },
      { id: "a", pinnedAt: "not-a-date" },
    ];
    expect(rows.sort(comparePinnedOrder).map((row) => row.id)).toEqual(["a", "b"]);
  });
});

describe("reassignPinnedTimestamps", () => {
  const iso = (ms: number) => new Date(ms).toISOString();

  it("re-deals the existing pool onto the new order and reports only changed entries", () => {
    const current = new Map([
      ["a", iso(1000)],
      ["b", iso(2000)],
      ["c", iso(3000)],
    ]);
    const changes = reassignPinnedTimestamps(["a", "c", "b"], current);
    // a keeps rank 1 (same timestamp), c and b swap the remaining pool values.
    expect(changes.has("a")).toBe(false);
    expect(changes.get("c")).toBe(iso(2000));
    expect(changes.get("b")).toBe(iso(3000));
  });

  it("is a no-op for an unchanged order", () => {
    const current = new Map([
      ["a", iso(1000)],
      ["b", iso(2000)],
    ]);
    expect(reassignPinnedTimestamps(["a", "b"], current).size).toBe(0);
  });

  it("preserves the pool max so later pins still append", () => {
    const current = new Map([
      ["a", iso(1000)],
      ["b", iso(2000)],
      ["c", iso(3000)],
    ]);
    const changes = reassignPinnedTimestamps(["c", "b", "a"], current);
    const maxAssigned = Math.max(
      ...["a", "b", "c"].map((id) => Date.parse(changes.get(id) ?? current.get(id) ?? ""))
    );
    expect(maxAssigned).toBe(3000);
  });

  it("nudges ties into a strictly monotonic sequence", () => {
    const current = new Map([
      ["a", iso(1000)],
      ["b", iso(1000)],
      ["c", iso(1000)],
    ]);
    const changes = reassignPinnedTimestamps(["b", "c", "a"], current);
    const assigned = ["b", "c", "a"].map((id) =>
      Date.parse(changes.get(id) ?? current.get(id) ?? "")
    );
    expect(assigned[0]).toBeLessThan(assigned[1]);
    expect(assigned[1]).toBeLessThan(assigned[2]);
  });

  it("handles unparseable values without breaking monotonicity", () => {
    const current = new Map([
      ["a", "garbage"],
      ["b", iso(500)],
    ]);
    const changes = reassignPinnedTimestamps(["b", "a"], current);
    const bMs = Date.parse(changes.get("b") ?? current.get("b") ?? "");
    const aMs = Date.parse(changes.get("a") ?? current.get("a") ?? "");
    expect(Number.isFinite(bMs)).toBe(true);
    expect(Number.isFinite(aMs)).toBe(true);
    expect(bMs).toBeLessThan(aMs);
  });
});

describe("recomposePinnedOrder", () => {
  it("replaces block ids in sequence while other positions stay fixed", () => {
    const fullOrder = ["s1", "a", "s2", "b", "c"];
    const blockIds = ["a", "b", "c"];
    const reordered = ["c", "a", "b"];
    expect(recomposePinnedOrder(fullOrder, blockIds, reordered)).toEqual([
      "s1",
      "c",
      "s2",
      "a",
      "b",
    ]);
  });
});
