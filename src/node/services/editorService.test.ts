import { describe, expect, test } from "bun:test";
import { getDetachedSpawnSpec } from "./editorService";

describe("getDetachedSpawnSpec", () => {
  test("wraps editor command in cmd.exe on Windows", () => {
    const spec = getDetachedSpawnSpec({
      platform: "win32",
      command: "code",
      args: ["C:\\Users\\Me\\proj"],
    });

    expect(spec).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "code", "C:\\Users\\Me\\proj"],
    });
  });

  test("spawns command directly on non-Windows platforms", () => {
    const spec = getDetachedSpawnSpec({
      platform: "linux",
      command: "code",
      args: ["/home/me/proj"],
    });

    expect(spec).toEqual({ command: "code", args: ["/home/me/proj"] });
  });
});
