import { arraysEqualByReference } from "./arrays";

describe("arraysEqualByReference", () => {
  it("returns true for two empty arrays", () => {
    expect(arraysEqualByReference([], [])).toBe(true);
  });

  it("returns true for arrays with same references", () => {
    const obj1 = { id: 1 };
    const obj2 = { id: 2 };
    const obj3 = { id: 3 };

    const a = [obj1, obj2, obj3];
    const b = [obj1, obj2, obj3];

    expect(arraysEqualByReference(a, b)).toBe(true);
  });

  it("returns false for arrays with different lengths", () => {
    const obj1 = { id: 1 };
    const obj2 = { id: 2 };

    const a = [obj1, obj2];
    const b = [obj1];

    expect(arraysEqualByReference(a, b)).toBe(false);
  });

  it("returns false when objects differ by reference", () => {
    const obj1 = { id: 1 };
    const obj2 = { id: 2 };
    const obj3 = { id: 3 };
    const obj4 = { id: 3 }; // Same value, different reference

    const a = [obj1, obj2, obj3];
    const b = [obj1, obj2, obj4];

    expect(arraysEqualByReference(a, b)).toBe(false);
  });

  it("returns false for arrays with same elements in different order", () => {
    const obj1 = { id: 1 };
    const obj2 = { id: 2 };

    const a = [obj1, obj2];
    const b = [obj2, obj1];

    expect(arraysEqualByReference(a, b)).toBe(false);
  });

  it("short-circuits on first mismatch", () => {
    const obj1 = { id: 1 };
    const obj2 = { id: 2 };
    const obj3 = { id: 3 };

    // Create large arrays where first element differs
    const a = [obj1, ...Array<{ id: number }>(1000).fill(obj2)];
    const b = [obj3, ...Array<{ id: number }>(1000).fill(obj2)];

    // Should return false immediately without checking all 1001 elements
    expect(arraysEqualByReference(a, b)).toBe(false);
  });

  it("works with primitive values", () => {
    const a = [1, 2, 3];
    const b = [1, 2, 3];

    expect(arraysEqualByReference(a, b)).toBe(true);
  });

  it("works with mixed types", () => {
    const obj = { id: 1 };
    const a = [1, "hello", obj, true, null];
    const b = [1, "hello", obj, true, null];

    expect(arraysEqualByReference(a, b)).toBe(true);
  });

  it("returns false for undefined vs null at same index", () => {
    const a = [undefined];
    const b = [null];

    expect(arraysEqualByReference(a, b)).toBe(false);
  });

  it("handles arrays with undefined elements", () => {
    const a = [1, undefined, 3];
    const b = [1, undefined, 3];

    expect(arraysEqualByReference(a, b)).toBe(true);
  });

  it("returns true for same array reference", () => {
    const a = [1, 2, 3];

    expect(arraysEqualByReference(a, a)).toBe(true);
  });
});
