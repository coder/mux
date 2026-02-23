import { resolveLocalPtyShell } from "./resolveLocalPtyShell";

describe("resolveLocalPtyShell", () => {
  it("uses SHELL when it is set, non-empty, and available", () => {
    const result = resolveLocalPtyShell({
      platform: "linux",
      env: { SHELL: "  /usr/bin/fish  " },
      isCommandAvailable: () => {
        throw new Error("isCommandAvailable should not be called");
      },
      isPathAccessible: (shellPath) => shellPath === "/usr/bin/fish",
      getBashPath: () => {
        throw new Error("getBashPath should not be called");
      },
    });

    expect(result).toEqual({ command: "/usr/bin/fish", args: [] });
  });

  it("on Windows, treats empty SHELL as unset and prefers Git Bash", () => {
    const gitBashPath = "C:\\Program Files\\Git\\bin\\bash.exe";
    const result = resolveLocalPtyShell({
      platform: "win32",
      env: { SHELL: "" },
      isCommandAvailable: () => false,
      isPathAccessible: (shellPath) => shellPath === gitBashPath,
      getBashPath: () => gitBashPath,
    });

    expect(result).toEqual({
      command: gitBashPath,
      args: ["--login", "-i"],
    });
  });

  it("on Windows, ignores POSIX-y SHELL paths and prefers Git Bash", () => {
    const gitBashPath = "C:\\Program Files\\Git\\bin\\bash.exe";
    const result = resolveLocalPtyShell({
      platform: "win32",
      env: { SHELL: "/bin/bash" },
      isCommandAvailable: () => false,
      isPathAccessible: (shellPath) => shellPath === gitBashPath,
      getBashPath: () => gitBashPath,
    });

    expect(result).toEqual({
      command: gitBashPath,
      args: ["--login", "-i"],
    });
  });

  it("on Windows, ignores WSL SHELL and prefers Git Bash", () => {
    const gitBashPath = "C:\\Program Files\\Git\\bin\\bash.exe";
    const result = resolveLocalPtyShell({
      platform: "win32",
      env: { SHELL: "C:\\Windows\\System32\\bash.exe" },
      isCommandAvailable: () => false,
      isPathAccessible: (shellPath) => shellPath === gitBashPath,
      getBashPath: () => gitBashPath,
    });

    expect(result).toEqual({
      command: gitBashPath,
      args: ["--login", "-i"],
    });
  });

  it("on Windows, ignores WSL wsl.exe in SHELL and prefers Git Bash", () => {
    const gitBashPath = "C:\\Program Files\\Git\\bin\\bash.exe";
    const result = resolveLocalPtyShell({
      platform: "win32",
      env: { SHELL: "C:\\Program Files\\WSL\\wsl.exe" },
      isCommandAvailable: () => false,
      isPathAccessible: (shellPath) => shellPath === gitBashPath,
      getBashPath: () => gitBashPath,
    });

    expect(result).toEqual({
      command: gitBashPath,
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
    const comspec = "C:\\Windows\\System32\\cmd.exe";
    const result = resolveLocalPtyShell({
      platform: "win32",
      env: { SHELL: "   ", COMSPEC: comspec },
      isCommandAvailable: () => false,
      isPathAccessible: (shellPath) => shellPath === comspec,
      getBashPath: () => {
        throw new Error("Git Bash not installed");
      },
    });

    expect(result).toEqual({ command: comspec, args: [] });
  });

  it("on Linux, falls back to /bin/bash when SHELL is unset", () => {
    const result = resolveLocalPtyShell({
      platform: "linux",
      env: {},
      isCommandAvailable: () => false,
      isPathAccessible: (shellPath) => shellPath === "/bin/bash",
      getBashPath: () => "bash",
    });

    expect(result).toEqual({ command: "/bin/bash", args: [] });
  });

  it("on macOS, falls back to /bin/zsh when SHELL is unset", () => {
    const result = resolveLocalPtyShell({
      platform: "darwin",
      env: {},
      isCommandAvailable: () => false,
      isPathAccessible: (shellPath) => shellPath === "/bin/zsh",
      getBashPath: () => "bash",
    });

    expect(result).toEqual({ command: "/bin/zsh", args: [] });
  });

  it("uses configuredShell when provided (absolute path)", () => {
    const result = resolveLocalPtyShell({
      configuredShell: "/usr/bin/fish",
      platform: "linux",
      env: { SHELL: "/bin/bash" },
      isCommandAvailable: () => {
        throw new Error("isCommandAvailable should not be called");
      },
      isPathAccessible: (shellPath) => shellPath === "/usr/bin/fish",
      getBashPath: () => {
        throw new Error("getBashPath should not be called");
      },
    });

    expect(result).toEqual({ command: "/usr/bin/fish", args: [] });
  });

  it("uses configuredShell when provided (command name)", () => {
    const result = resolveLocalPtyShell({
      configuredShell: "fish",
      platform: "linux",
      env: { SHELL: "/bin/bash" },
      isCommandAvailable: (command) => command === "fish",
      getBashPath: () => {
        throw new Error("getBashPath should not be called");
      },
    });

    expect(result).toEqual({ command: "fish", args: [] });
  });

  it("ignores whitespace-only configuredShell", () => {
    const result = resolveLocalPtyShell({
      configuredShell: "   ",
      platform: "linux",
      env: { SHELL: "/usr/bin/fish" },
      isCommandAvailable: () => false,
      isPathAccessible: (shellPath) => shellPath === "/usr/bin/fish",
      getBashPath: () => "bash",
    });

    expect(result).toEqual({ command: "/usr/bin/fish", args: [] });
  });

  it("configuredShell overrides on Windows too", () => {
    const configuredShell = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    const result = resolveLocalPtyShell({
      configuredShell,
      platform: "win32",
      env: { SHELL: "" },
      isCommandAvailable: () => false,
      isPathAccessible: (shellPath) => shellPath === configuredShell,
      getBashPath: () => "C:\\Program Files\\Git\\bin\\bash.exe",
    });

    expect(result).toEqual({
      command: configuredShell,
      args: [],
    });
  });

  it("falls back to SHELL when configured command-name is invalid", () => {
    const result = resolveLocalPtyShell({
      configuredShell: "fihs",
      platform: "linux",
      env: { SHELL: "/usr/bin/fish" },
      isCommandAvailable: (command) => command !== "fihs" && command === "fish",
      isPathAccessible: (shellPath) => shellPath === "/usr/bin/fish",
      getBashPath: () => "bash",
    });

    expect(result).toEqual({ command: "/usr/bin/fish", args: [] });
  });

  it("falls back to platform chain when configured absolute path is invalid", () => {
    const result = resolveLocalPtyShell({
      configuredShell: "/usr/bin/fihs",
      platform: "linux",
      env: {},
      isCommandAvailable: () => false,
      isPathAccessible: (shellPath) => shellPath === "/bin/bash",
      getBashPath: () => "bash",
    });

    expect(result).toEqual({ command: "/bin/bash", args: [] });
  });

  it("keeps configured absolute path as highest priority when it is valid", () => {
    const configuredShell = "/usr/local/bin/fish";
    const result = resolveLocalPtyShell({
      configuredShell,
      platform: "linux",
      env: { SHELL: "/usr/bin/zsh" },
      isCommandAvailable: () => false,
      isPathAccessible: (shellPath) =>
        shellPath === configuredShell || shellPath === "/usr/bin/zsh",
      getBashPath: () => "bash",
    });

    expect(result).toEqual({ command: configuredShell, args: [] });
  });

  it("falls back to platform default when configured shell and SHELL are invalid", () => {
    const result = resolveLocalPtyShell({
      configuredShell: "fihs",
      platform: "linux",
      env: { SHELL: "/usr/bin/fihs" },
      isCommandAvailable: () => false,
      isPathAccessible: (shellPath) => shellPath === "/bin/bash",
      getBashPath: () => "bash",
    });

    expect(result).toEqual({ command: "/bin/bash", args: [] });
  });

  it("skips configured path that is a directory and falls back to SHELL", () => {
    // Simulates configuredShell="/usr/bin" (a directory, not an executable).
    const result = resolveLocalPtyShell({
      configuredShell: "/usr/bin",
      platform: "linux",
      env: { SHELL: "/bin/bash" },
      isCommandAvailable: () => false,
      // /usr/bin exists but should not be accepted; /bin/bash is the valid shell.
      isPathAccessible: (shellPath) => shellPath === "/bin/bash",
      getBashPath: () => "bash",
    });

    expect(result).toEqual({ command: "/bin/bash", args: [] });
  });

  it("skips configured path that is a non-executable file and falls back", () => {
    // Simulates configuredShell="/etc/hosts" (exists but not executable).
    const result = resolveLocalPtyShell({
      configuredShell: "/etc/hosts",
      platform: "linux",
      env: { SHELL: "/bin/bash" },
      isCommandAvailable: () => false,
      // /etc/hosts exists but should not be accepted.
      isPathAccessible: (shellPath) => shellPath === "/bin/bash",
      getBashPath: () => "bash",
    });

    expect(result).toEqual({ command: "/bin/bash", args: [] });
  });

  it("skips SHELL env when it points to a non-executable path", () => {
    const result = resolveLocalPtyShell({
      platform: "linux",
      env: { SHELL: "/etc/hosts" },
      isCommandAvailable: () => false,
      isPathAccessible: (shellPath) => shellPath === "/bin/bash",
      getBashPath: () => "bash",
    });

    expect(result).toEqual({ command: "/bin/bash", args: [] });
  });

  it("on Windows, final fallback returns cmd.exe when all candidates fail and COMSPEC is empty", () => {
    const result = resolveLocalPtyShell({
      platform: "win32",
      env: { SHELL: "", COMSPEC: "" },
      isCommandAvailable: () => false,
      isPathAccessible: () => false,
      getBashPath: () => {
        throw new Error("Git Bash not installed");
      },
    });

    expect(result).toEqual({ command: "cmd.exe", args: [] });
  });

  it("on Windows, final fallback returns cmd.exe when all candidates fail and COMSPEC path is invalid", () => {
    const result = resolveLocalPtyShell({
      platform: "win32",
      env: { SHELL: "", COMSPEC: "C:\\Broken\\cmd.exe" },
      isCommandAvailable: () => false,
      isPathAccessible: () => false,
      getBashPath: () => {
        throw new Error("Git Bash not installed");
      },
    });

    expect(result).toEqual({ command: "cmd.exe", args: [] });
  });
});
