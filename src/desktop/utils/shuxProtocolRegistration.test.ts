import { describe, expect, test } from "bun:test";
import * as path from "path";
import {
  getShuxDeepLinksFromArgv,
  getShuxProtocolClientRegistration,
} from "./shuxProtocolRegistration";

describe("getShuxProtocolClientRegistration", () => {
  test("adds -- before the app entry path for Windows defaultApp registration", () => {
    expect(
      getShuxProtocolClientRegistration({
        platform: "win32",
        isPackaged: false,
        defaultApp: true,
        argv: ["electron", "./src/cli/index.ts"],
        execPath: "/tmp/electron",
      })
    ).toEqual({
      executable: "/tmp/electron",
      args: ["--", path.resolve("./src/cli/index.ts")],
    });
  });

  test("keeps non-Windows defaultApp registration unchanged", () => {
    expect(
      getShuxProtocolClientRegistration({
        platform: "linux",
        isPackaged: false,
        defaultApp: true,
        argv: ["electron", "./src/cli/index.ts"],
        execPath: "/tmp/electron",
      })
    ).toEqual({
      executable: "/tmp/electron",
      args: [path.resolve("./src/cli/index.ts")],
    });
  });

  test("falls back to packaged/default protocol registration when no defaultApp command is needed", () => {
    expect(
      getShuxProtocolClientRegistration({
        platform: "win32",
        isPackaged: true,
        defaultApp: undefined,
        argv: ["/Applications/Shux.app/Contents/MacOS/Shux"],
        execPath: "/Applications/Shux.app/Contents/MacOS/Shux",
      })
    ).toBeNull();
  });
});

describe("getShuxDeepLinksFromArgv", () => {
  test("finds canonical and legacy links even when a -- separator is present", () => {
    expect(
      getShuxDeepLinksFromArgv([
        "electron",
        ".",
        "--",
        "./src/cli/index.ts",
        "shux://chat/new?project=shux",
        "mux://chat/new?project=mux",
      ])
    ).toEqual(["shux://chat/new?project=shux", "mux://chat/new?project=mux"]);
  });

  test("ignores non-protocol arguments", () => {
    expect(
      getShuxDeepLinksFromArgv(["electron", ".", "--", "./src/cli/index.ts", "--help"])
    ).toEqual([]);
  });
});
