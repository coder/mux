/**
 * Check if two arrays are equal by reference equality of elements.
 *
 * This is useful for checking if array contents changed when elements are
 * immutable objects. If elements are new objects but structurally equal,
 * this will return false (reference inequality).
 *
 * Performance: O(n) where n is array length. Short-circuits on first mismatch.
 *
 * @example
 * const a = [obj1, obj2, obj3];
 * const b = [obj1, obj2, obj3];
 * arraysEqualByReference(a, b); // true (same references)
 *
 * const c = [obj1, obj2, obj4];
 * arraysEqualByReference(a, c); // false (different obj at index 2)
 */
export function arraysEqualByReference<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
}
