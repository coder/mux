import { describe, expect, test } from "bun:test";

import {
  attachModelOnlyToolNotifications,
  MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD,
  stripInternalToolResultFields,
} from "./internalToolResultFields";

describe("internalToolResultFields", () => {
  test("attachModelOnlyToolNotifications only attaches to plain objects", () => {
    expect(attachModelOnlyToolNotifications("hello", ["<n/>"])).toBe("hello");

    const attached = attachModelOnlyToolNotifications({ ok: true }, ["<n/>"]) as Record<
      string,
      unknown
    >;
    expect(attached.ok).toBe(true);
    expect(attached[MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD]).toEqual(["<n/>"]);
  });

  test("stripInternalToolResultFields removes model-only notifications", () => {
    const input = { ok: true, [MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD]: ["a"] };
    const stripped = stripInternalToolResultFields(input) as Record<string, unknown>;

    expect(stripped.ok).toBe(true);
    expect(MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD in stripped).toBe(false);
  });
});
