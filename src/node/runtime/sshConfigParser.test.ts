import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { resolveSSHConfig } from "./sshConfigParser";

describe("resolveSSHConfig", () => {
  test("does not execute Match !exec proxy rules", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-ssh-config-"));
    const previousUserProfile = process.env.USERPROFILE;

    process.env.USERPROFILE = tempDir;

    try {
      await fs.mkdir(path.join(tempDir, ".ssh"), { recursive: true });

      const config = [
        "Host *.mux--coder",
        "  User coder-user",
        "  UserKnownHostsFile /dev/null",
        "",
        'Match host *.mux--coder !exec "exit 1"',
        "  ProxyCommand /usr/local/bin/coder --stdio %h",
        "",
      ].join("\n");

      await fs.writeFile(path.join(tempDir, ".ssh", "config"), config, "utf8");

      const resolved = await resolveSSHConfig("pog2.mux--coder");

      expect(resolved.user).toBe("coder-user");
      expect(resolved.hostName).toBe("pog2.mux--coder");
      expect(resolved.proxyCommand).toBeUndefined();
    } finally {
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }

      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("ignores Match !exec even when %r token is present", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-ssh-config-"));
    const previousUserProfile = process.env.USERPROFILE;

    process.env.USERPROFILE = tempDir;

    try {
      await fs.mkdir(path.join(tempDir, ".ssh"), { recursive: true });

      const config = [
        "Host test-host",
        "  HostName 10.0.0.1",
        "",
        'Match host 10.0.0.1 !exec "test -z %r"',
        "  ProxyCommand /usr/bin/proxy --user %r",
        "",
      ].join("\n");

      await fs.writeFile(path.join(tempDir, ".ssh", "config"), config, "utf8");

      const resolved = await resolveSSHConfig("test-host");

      expect(resolved.proxyCommand).toBeUndefined();
      // user should be undefined since no User directive
      expect(resolved.user).toBeUndefined();
    } finally {
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }

      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
