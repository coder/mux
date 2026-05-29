import { describe, expect, test } from "bun:test";

import { isAllowedOrpcPath } from "./orpcAllowlist";

describe("isAllowedOrpcPath", () => {
  test("allows known procedures", () => {
    expect(isAllowedOrpcPath(["general", "ping"]))
      .toBe(true);
    expect(isAllowedOrpcPath(["workspace", "sendMessage"]))
      .toBe(true);
    expect(isAllowedOrpcPath(["providers", "getConfig"]))
      .toBe(true);
  });

  test("rejects unknown roots and procedures", () => {
    expect(isAllowedOrpcPath(["server", "getApiServerStatus"]))
      .toBe(false);
    expect(isAllowedOrpcPath(["workspace", "create"]))
      .toBe(false);
    expect(isAllowedOrpcPath(["providers", "setProviderConfig"]))
      .toBe(false);
  });

  test("rejects nested routers", () => {
    expect(isAllowedOrpcPath(["workspace", "backgroundBashes", "subscribe"]))
      .toBe(false);
  });

  test("rejects invalid segments", () => {
    expect(isAllowedOrpcPath([])).toBe(false);
    expect(isAllowedOrpcPath(["workspace", "__proto__"]))
      .toBe(false);
    expect(isAllowedOrpcPath(["workspace", "send-message"]))
      .toBe(false);
  });
});
