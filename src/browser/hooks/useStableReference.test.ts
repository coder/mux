/**
 * Tests for stable reference utilities.
 *
 * Note: Hook tests (useStableReference) are omitted because they require jsdom setup.
 * The comparator functions are the critical logic and are thoroughly tested here.
 * The hook itself is a thin wrapper around useMemo and useRef with manual testing.
 */
import { compareMaps, compareRecords, compareArrays } from "./useStableReference";

describe("compareMaps", () => {
  it("returns true for empty maps", () => {
    expect(compareMaps(new Map(), new Map())).toBe(true);
  });

  it("returns true for maps with same entries", () => {
    const prev = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    const next = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    expect(compareMaps(prev, next)).toBe(true);
  });

  it("returns false for maps with different sizes", () => {
    const prev = new Map([["a", 1]]);
    const next = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    expect(compareMaps(prev, next)).toBe(false);
  });

  it("returns false for maps with different keys", () => {
    const prev = new Map([["a", 1]]);
    const next = new Map([["b", 1]]);
    expect(compareMaps(prev, next)).toBe(false);
  });

  it("returns false for maps with different values", () => {
    const prev = new Map([["a", 1]]);
    const next = new Map([["a", 2]]);
    expect(compareMaps(prev, next)).toBe(false);
  });

  it("supports custom value equality function", () => {
    const prev = new Map([["a", { id: 1 }]]);
    const next = new Map([["a", { id: 1 }]]);

    // Default comparison (reference equality) returns false
    expect(compareMaps(prev, next)).toBe(false);

    // Custom comparison (by id) returns true
    expect(compareMaps(prev, next, (a, b) => a.id === b.id)).toBe(true);
  });
});

describe("compareRecords", () => {
  it("returns true for empty records", () => {
    expect(compareRecords({}, {})).toBe(true);
  });

  it("returns true for records with same entries", () => {
    const prev = { a: 1, b: 2 };
    const next = { a: 1, b: 2 };
    expect(compareRecords(prev, next)).toBe(true);
  });

  it("returns false for records with different sizes", () => {
    const prev = { a: 1 };
    const next = { a: 1, b: 2 };
    expect(compareRecords(prev, next)).toBe(false);
  });

  it("returns false for records with different keys", () => {
    const prev = { a: 1 };
    const next = { b: 1 };
    expect(compareRecords(prev, next)).toBe(false);
  });

  it("returns false for records with different values", () => {
    const prev = { a: 1 };
    const next = { a: 2 };
    expect(compareRecords(prev, next)).toBe(false);
  });

  it("supports custom value equality function", () => {
    const prev = { a: { id: 1 } };
    const next = { a: { id: 1 } };

    // Default comparison (reference equality) returns false
    expect(compareRecords(prev, next)).toBe(false);

    // Custom comparison (by id) returns true
    expect(compareRecords(prev, next, (a, b) => a.id === b.id)).toBe(true);
  });
});

describe("compareArrays", () => {
  it("returns true for empty arrays", () => {
    expect(compareArrays([], [])).toBe(true);
  });

  it("returns true for arrays with same elements", () => {
    expect(compareArrays([1, 2, 3], [1, 2, 3])).toBe(true);
  });

  it("returns false for arrays with different lengths", () => {
    expect(compareArrays([1, 2], [1, 2, 3])).toBe(false);
  });

  it("returns false for arrays with different values", () => {
    expect(compareArrays([1, 2, 3], [1, 2, 4])).toBe(false);
  });

  it("returns false for arrays with same values in different order", () => {
    expect(compareArrays([1, 2, 3], [3, 2, 1])).toBe(false);
  });

  it("supports custom value equality function", () => {
    const prev = [{ id: 1 }, { id: 2 }];
    const next = [{ id: 1 }, { id: 2 }];

    // Default comparison (reference equality) returns false
    expect(compareArrays(prev, next)).toBe(false);

    // Custom comparison (by id) returns true
    expect(compareArrays(prev, next, (a, b) => a.id === b.id)).toBe(true);
  });
});

// Hook integration tests would require jsdom setup with bun.
// The comparator functions above are the critical logic and are thoroughly tested.
// The hook itself is tested manually through its usage in useUnreadTracking,
// useWorkspaceAggregators, and GitStatusContext.
