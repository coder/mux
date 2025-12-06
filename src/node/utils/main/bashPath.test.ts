import { describe, it, expect } from "bun:test";
import {
  detectBashRuntimes,
  getSpawnConfig,
  getPreferredSpawnConfig,
  isBashAvailable,
  windowsToWslPath,
  translateWindowsPathsInCommand,
  type BashRuntime,
} from "./bashPath";

describe("bashPath", () => {
  describe("detectBashRuntimes", () => {
    it("should detect at least one runtime", () => {
      const runtimes = detectBashRuntimes();
      expect(runtimes.available.length).toBeGreaterThan(0);
      expect(runtimes.preferred).toBeDefined();
    });

    it("should return unix runtime on non-Windows platforms", () => {
      // This test runs on Linux/macOS CI
      if (process.platform !== "win32") {
        const runtimes = detectBashRuntimes();
        expect(runtimes.preferred.type).toBe("unix");
        expect(runtimes.available).toContainEqual({ type: "unix" });
      }
    });

    it("should cache results", () => {
      const first = detectBashRuntimes();
      const second = detectBashRuntimes();
      expect(first).toBe(second); // Same object reference
    });
  });

  describe("getSpawnConfig", () => {
    it("should generate correct config for unix runtime", () => {
      const runtime: BashRuntime = { type: "unix" };
      const config = getSpawnConfig(runtime, "echo hello");

      expect(config.command).toBe("bash");
      expect(config.args).toEqual(["-c", "echo hello"]);
    });

    it("should generate correct config for git-bash runtime", () => {
      const runtime: BashRuntime = {
        type: "git-bash",
        bashPath: "C:\\Program Files\\Git\\bin\\bash.exe",
      };
      const config = getSpawnConfig(runtime, "echo hello");

      expect(config.command).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
      expect(config.args).toEqual(["-c", "echo hello"]);
    });

    it("should generate correct config for wsl runtime with distro", () => {
      const runtime: BashRuntime = { type: "wsl", distro: "Ubuntu" };
      const config = getSpawnConfig(runtime, "echo hello");

      expect(config.command).toBe("wsl");
      expect(config.args).toContain("-d");
      expect(config.args).toContain("Ubuntu");
      expect(config.args).toContain("--");
      expect(config.args).toContain("bash");
      expect(config.args).toContain("-c");
      expect(config.args[config.args.length - 1]).toContain("echo hello");
    });

    it("should generate correct config for wsl runtime without distro", () => {
      const runtime: BashRuntime = { type: "wsl", distro: null };
      const config = getSpawnConfig(runtime, "echo hello");

      expect(config.command).toBe("wsl");
      expect(config.args).not.toContain("-d");
      expect(config.args).toContain("--");
      expect(config.args).toContain("bash");
      expect(config.args[config.args.length - 1]).toContain("echo hello");
    });

    it("should handle complex scripts with quotes and special characters", () => {
      const runtime: BashRuntime = { type: "unix" };
      const script = 'git commit -m "test message" && echo "done"';
      const config = getSpawnConfig(runtime, script);

      expect(config.args[1]).toBe(script);
    });
  });

  describe("getPreferredSpawnConfig", () => {
    it("should return valid spawn config", () => {
      const config = getPreferredSpawnConfig("ls -la");

      expect(config.command).toBeDefined();
      expect(config.args).toBeArray();
      expect(config.args.length).toBeGreaterThan(0);
    });

    it("should include the script in args", () => {
      const script = "git status --porcelain";
      const config = getPreferredSpawnConfig(script);

      // Script should be in args (either directly or as part of -c arg)
      expect(config.args.join(" ")).toContain(script);
    });
  });

  describe("isBashAvailable", () => {
    it("should return true when bash is available", () => {
      // On CI (Linux), bash should always be available
      if (process.platform !== "win32") {
        expect(isBashAvailable()).toBe(true);
      }
    });
  });

  describe("windowsToWslPath", () => {
    it("should convert C:\\ paths to /mnt/c/", () => {
      expect(windowsToWslPath("C:\\Users\\micha\\source\\mux")).toBe(
        "/mnt/c/Users/micha/source/mux"
      );
    });

    it("should convert D:\\ paths to /mnt/d/", () => {
      expect(windowsToWslPath("D:\\Projects\\myapp")).toBe("/mnt/d/Projects/myapp");
    });

    it("should handle lowercase drive letters", () => {
      expect(windowsToWslPath("c:\\temp")).toBe("/mnt/c/temp");
    });

    it("should handle forward slashes in Windows paths", () => {
      expect(windowsToWslPath("C:/Users/micha")).toBe("/mnt/c/Users/micha");
    });

    it("should return non-Windows paths unchanged", () => {
      expect(windowsToWslPath("/home/user")).toBe("/home/user");
      expect(windowsToWslPath("relative/path")).toBe("relative/path");
    });

    it("should handle paths with spaces", () => {
      expect(windowsToWslPath("C:\\Program Files\\Git")).toBe("/mnt/c/Program Files/Git");
    });
  });

  describe("translateWindowsPathsInCommand", () => {
    it("should translate unquoted paths", () => {
      expect(translateWindowsPathsInCommand("cd C:\\Users\\micha")).toBe("cd /mnt/c/Users/micha");
    });

    it("should translate double-quoted paths", () => {
      expect(translateWindowsPathsInCommand('git -C "C:\\Users\\micha\\mux" status')).toBe(
        'git -C "/mnt/c/Users/micha/mux" status'
      );
    });

    it("should translate single-quoted paths", () => {
      expect(translateWindowsPathsInCommand("ls 'D:\\Projects'")).toBe("ls '/mnt/d/Projects'");
    });

    it("should translate multiple paths in one command", () => {
      expect(translateWindowsPathsInCommand('cp "C:\\src" "D:\\dest"')).toBe(
        'cp "/mnt/c/src" "/mnt/d/dest"'
      );
    });

    it("should leave non-Windows paths alone", () => {
      const cmd = "ls /home/user && cat file.txt";
      expect(translateWindowsPathsInCommand(cmd)).toBe(cmd);
    });

    it("should handle git -C commands", () => {
      expect(
        translateWindowsPathsInCommand('git -C "C:\\Users\\micha\\source\\mux" worktree list')
      ).toBe('git -C "/mnt/c/Users/micha/source/mux" worktree list');
    });

    it("should handle double-quoted paths with spaces", () => {
      expect(translateWindowsPathsInCommand('cd "C:\\Users\\John Doe\\My Documents"')).toBe(
        'cd "/mnt/c/Users/John Doe/My Documents"'
      );
    });

    it("should handle single-quoted paths with spaces", () => {
      expect(translateWindowsPathsInCommand("cd 'D:\\Program Files\\My App'")).toBe(
        "cd '/mnt/d/Program Files/My App'"
      );
    });

    it("should handle mixed quoted paths with and without spaces", () => {
      expect(
        translateWindowsPathsInCommand('cp "C:\\Users\\John Doe\\file.txt" C:\\dest')
      ).toBe('cp "/mnt/c/Users/John Doe/file.txt" /mnt/c/dest');
    });
  });

  describe("getSpawnConfig with WSL path translation", () => {
    it("should translate cwd for WSL runtime", () => {
      const runtime: BashRuntime = { type: "wsl", distro: "Ubuntu" };
      const config = getSpawnConfig(runtime, "ls", "C:\\Users\\micha");

      // cwd is embedded in the script via 'cd' command
      expect(config.cwd).toBeUndefined();
      // The translated cwd should be in the bash script
      const bashScript = config.args[config.args.length - 1];
      expect(bashScript).toContain("/mnt/c/Users/micha");
    });

    it("should translate paths in script for WSL runtime", () => {
      const runtime: BashRuntime = { type: "wsl", distro: null };
      const config = getSpawnConfig(runtime, 'git -C "C:\\Projects\\app" status');

      // The script has translated paths
      const bashScript = config.args[config.args.length - 1];
      expect(bashScript).toContain("/mnt/c/Projects/app");
    });

    it("should not translate paths for git-bash runtime", () => {
      const runtime: BashRuntime = {
        type: "git-bash",
        bashPath: "C:\\Program Files\\Git\\bin\\bash.exe",
      };
      const config = getSpawnConfig(runtime, 'git -C "C:\\Projects" status', "C:\\Projects");

      expect(config.cwd).toBe("C:\\Projects");
      expect(config.args[1]).toBe('git -C "C:\\Projects" status');
    });

    it("should not translate paths for unix runtime", () => {
      const runtime: BashRuntime = { type: "unix" };
      const config = getSpawnConfig(runtime, "ls", "/home/user");

      expect(config.cwd).toBe("/home/user");
    });
  });
});
