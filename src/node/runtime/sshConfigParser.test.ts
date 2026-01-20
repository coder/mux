import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { resolveSSHConfig } from "./sshConfigParser";

describe("resolveSSHConfig", () => {
  test("applies Host + Match host proxy rules", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-ssh-config-"));
    const previousUserProfile = process.env.USERPROFILE;

    process.env.USERPROFILE = tempDir;

    try {
      await fs.mkdir(path.join(tempDir, ".ssh"), { recursive: true });

      const config = [
        "Host *.coder",
        "  User coder-user",
        "  UserKnownHostsFile /dev/null",
        "",
        'Match host *.coder !exec "exit 1"',
        "  ProxyCommand /usr/local/bin/coder --stdio %h",
        "",
      ].join("\n");

      await fs.writeFile(path.join(tempDir, ".ssh", "config"), config, "utf8");

      const resolved = await resolveSSHConfig("pog2.coder");

      expect(resolved.user).toBe("coder-user");
      expect(resolved.hostName).toBe("pog2.coder");
      expect(resolved.proxyCommand).toBe("/usr/local/bin/coder --stdio %h");
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
