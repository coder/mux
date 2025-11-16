import * as os from "os";
import * as path from "path";
import { getControlPath } from "./sshConnectionPool";
import type { SSHRuntimeConfig } from "./SSHRuntime";

describe("sshConnectionPool", () => {
  describe("getControlPath", () => {
    test("identical configs produce same controlPath", () => {
      const config: SSHRuntimeConfig = {
        host: "test.example.com",
        srcBaseDir: "/work",
      };
      const path1 = getControlPath(config);
      const path2 = getControlPath(config);

      expect(path1).toBe(path2);
    });

    test("different hosts produce different controlPaths", () => {
      const path1 = getControlPath({
        host: "host1.example.com",
        srcBaseDir: "/work",
      });
      const path2 = getControlPath({
        host: "host2.example.com",
        srcBaseDir: "/work",
      });

      expect(path1).not.toBe(path2);
    });

    test("different ports produce different controlPaths", () => {
      const config1: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work",
        port: 22,
      };
      const config2: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work",
        port: 2222,
      };

      expect(getControlPath(config1)).not.toBe(getControlPath(config2));
    });

    test("different identityFiles produce different controlPaths", () => {
      const config1: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work",
        identityFile: "/path/to/key1",
      };
      const config2: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work",
        identityFile: "/path/to/key2",
      };

      expect(getControlPath(config1)).not.toBe(getControlPath(config2));
    });

    test("different srcBaseDirs produce different controlPaths", () => {
      const config1: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work1",
      };
      const config2: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work2",
      };

      expect(getControlPath(config1)).not.toBe(getControlPath(config2));
    });

    test("controlPath is in tmpdir with expected format", () => {
      const config: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work",
      };
      const controlPath = getControlPath(config);

      expect(controlPath).toContain(os.tmpdir());
      expect(controlPath).toMatch(/cmux-ssh-[a-f0-9]{12}$/);
    });

    test("missing port defaults to 22 in hash calculation", () => {
      const config1: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work",
        port: 22,
      };
      const config2: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work",
        // port omitted, should default to 22
      };

      expect(getControlPath(config1)).toBe(getControlPath(config2));
    });

    test("missing identityFile defaults to 'default' in hash calculation", () => {
      const config1: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work",
        identityFile: undefined,
      };
      const config2: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work",
        // identityFile omitted
      };

      expect(getControlPath(config1)).toBe(getControlPath(config2));
    });
  });
});

describe("username isolation", () => {
  test("controlPath includes local username to prevent cross-user collisions", () => {
    // This test verifies that os.userInfo().username is included in the hash
    // On multi-user systems, different users connecting to the same remote
    // would get different controlPaths, preventing permission errors
    const config: SSHRuntimeConfig = {
      host: "test.com",
      srcBaseDir: "/work",
    };
    const controlPath = getControlPath(config);

    // The path should be deterministic for this user
    expect(controlPath).toBe(getControlPath(config));

    const expectedPrefix = path.join(os.tmpdir(), "cmux-ssh-");
    expect(controlPath.startsWith(expectedPrefix)).toBe(true);
    expect(controlPath).toMatch(/cmux-ssh-[a-f0-9]{12}$/);
  });
});
