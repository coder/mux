import { resolveLocalPtyShell } from "./resolveLocalPtyShell";

describe("resolveLocalPtyShell", () => {
  it("uses SHELL when it is set and non-empty", () => {
    const result = resolveLocalPtyShell({
      platform: "linux",
      env: { SHELL: "  /usr/bin/fish  " },
      isCommandAvailable: () => {
        throw new Error("isCommandAvailable should not be called");
      },
      getBashPath: () => {
        throw new Error("getBashPath should not be called");
      },
    });

    expect(result).toEqual({ command: "/usr/bin/fish", args: [] });
  });

  it("on Windows, treats empty SHELL as unset and prefers Git Bash", () => {
    const result = resolveLocalPtyShell({
      platform: "win32",
      env: { SHELL: "" },
      isCommandAvailable: () => false,
      getBashPath: () => "C:\\Program Files\\Git\\bin\\bash.exe",
    });

    expect(result).toEqual({
      command: "C:\\Program Files\\Git\\bin\\bash.exe",
      args: ["--login", "-i"],
    });
  });

  it("on Windows, ignores POSIX-y SHELL paths and prefers Git Bash", () => {
    const result = resolveLocalPtyShell({
      platform: "win32",
      env: { SHELL: "/bin/bash" },
      isCommandAvailable: () => false,
      getBashPath: () => "C:\\Program Files\\Git\\bin\\bash.exe",
    });

    expect(result).toEqual({
      command: "C:\\Program Files\\Git\\bin\\bash.exe",
      args: ["--login", "-i"],
    });
  });
  it("on Windows, ignores WSL SHELL and prefers Git Bash", () => {
    const result = resolveLocalPtyShell({
      platform: "win32",
      env: { SHELL: "C:\\Windows\\System32\\bash.exe" },
      isCommandAvailable: () => false,
      getBashPath: () => "C:\\Program Files\\Git\\bin\\bash.exe",
    });

    expect(result).toEqual({
      command: "C:\\Program Files\\Git\\bin\\bash.exe",
      args: ["--login", "-i"],
    });
  });

  it("on Windows, ignores WSL wsl.exe in SHELL and prefers Git Bash", () => {
    const result = resolveLocalPtyShell({
      platform: "win32",
      env: { SHELL: "C:\\Program Files\\WSL\\wsl.exe" },
      isCommandAvailable: () => false,
      getBashPath: () => "C:\\Program Files\\Git\\bin\\bash.exe",
    });

    expect(result).toEqual({
      command: "C:\\Program Files\\Git\\bin\\bash.exe",
      args: ["--login", "-i"],
    });
  });

  it("on Windows, falls back to pwsh when Git Bash is unavailable", () => {
    const result = resolveLocalPtyShell({
      platform: "win32",
      env: { SHELL: "" },
      isCommandAvailable: (command) => command === "pwsh",
      getBashPath: () => {
        throw new Error("Git Bash not installed");
      },
    });

    expect(result).toEqual({ command: "pwsh", args: [] });
  });

  it("on Windows, falls back to COMSPEC/cmd.exe when no other shells are available", () => {
    const result = resolveLocalPtyShell({
      platform: "win32",
      env: { SHELL: "   ", COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
      isCommandAvailable: () => false,
      getBashPath: () => {
        throw new Error("Git Bash not installed");
      },
    });

    expect(result).toEqual({ command: "C:\\Windows\\System32\\cmd.exe", args: [] });
  });

  it("on Linux, falls back to /bin/bash when SHELL is unset", () => {
    const result = resolveLocalPtyShell({
      platform: "linux",
      env: {},
      isCommandAvailable: () => false,
      getBashPath: () => "bash",
    });

    expect(result).toEqual({ command: "/bin/bash", args: [] });
  });

  it("on macOS, falls back to /bin/zsh when SHELL is unset", () => {
    const result = resolveLocalPtyShell({
      platform: "darwin",
      env: {},
      isCommandAvailable: () => false,
      getBashPath: () => "bash",
    });

    expect(result).toEqual({ command: "/bin/zsh", args: [] });
  });
});
