import { describe, expect, test } from "bun:test";
import { parseMuxDeepLink } from "./deepLink";

describe("parseMuxDeepLink", () => {
  test("parses mux://chat/new", () => {
    const payload = parseMuxDeepLink(
      "mux://chat/new?projectPath=%2Ftmp%2Frepo&projectId=proj_123&prompt=hello%20world&sectionId=sec_456"
    );

    expect(payload).toEqual({
      type: "new_chat",
      projectPath: "/tmp/repo",
      projectId: "proj_123",
      prompt: "hello world",
      sectionId: "sec_456",
    });
  });

  test("returns null for invalid scheme", () => {
    expect(parseMuxDeepLink("http://chat/new?prompt=hi")).toBeNull();
  });

  test("returns null for unknown route", () => {
    expect(parseMuxDeepLink("mux://chat/old?prompt=hi")).toBeNull();
  });
});
