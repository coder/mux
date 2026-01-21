import { getBashPath, getBashPathForPlatform, resetBashPathCache } from "./bashPath";

describe("getBashPathForPlatform (Windows)", () => {
  it("skips WSL launcher when it is first in PATH", () => {
    const execSyncFn = (command: string) => {
      if (command === "where git") {
        throw new Error("git not in PATH");
      }

      if (command === "where bash") {
        return ["C:\\Windows\\System32\\bash.exe", "D:\\Custom\\Git\\usr\\bin\\bash.exe"].join(
          "\r\n"
        );
      }

      throw new Error(`unexpected command: ${command}`);
    };

    const existing = new Set<string>([
      "C:\\Windows\\System32\\bash.exe",
      "D:\\Custom\\Git\\usr\\bin\\bash.exe",
      "D:\\Custom\\Git\\cmd\\git.exe",
    ]);

    const existsSyncFn = (p: unknown) => existing.has(String(p));

    expect(
      getBashPathForPlatform({
        platform: "win32",
        env: {},
        execSyncFn,
        existsSyncFn,
      })
    ).toBe("D:\\Custom\\Git\\usr\\bin\\bash.exe");
  });

  it("throws when only WSL bash is available", () => {
    const execSyncFn = (command: string) => {
      if (command === "where git") {
        throw new Error("git not in PATH");
      }

      if (command === "where bash") {
        return "C:\\Windows\\System32\\bash.exe\r\n";
      }

      throw new Error(`unexpected command: ${command}`);
    };

    const existing = new Set<string>(["C:\\Windows\\System32\\bash.exe"]);
    const existsSyncFn = (p: unknown) => existing.has(String(p));

    expect(() =>
      getBashPathForPlatform({
        platform: "win32",
        env: {},
        execSyncFn,
        existsSyncFn,
      })
    ).toThrow(/WSL is not supported/);
  });
});

describe("getBashPath (Windows)", () => {
  beforeEach(() => {
    resetBashPathCache();
  });

  it("caches failures to avoid repeated `where` probes", () => {
    let execCalls = 0;
    const execSyncFn = () => {
      execCalls++;
      throw new Error("not in PATH");
    };

    const existsSyncFn = () => false;
    const nowFn = () => 0;

    expect(() =>
      getBashPath({
        platform: "win32",
        env: {},
        execSyncFn,
        existsSyncFn,
        nowFn,
      })
    ).toThrow(/Git Bash not found/);

    const callsAfterFirst = execCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    expect(() =>
      getBashPath({
        platform: "win32",
        env: {},
        execSyncFn,
        existsSyncFn,
        nowFn,
      })
    ).toThrow(/Git Bash not found/);

    expect(execCalls).toBe(callsAfterFirst);
  });
});
