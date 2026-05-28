import { describe, expect, test } from "bun:test";

import { runDebugExtensionInstall } from "./extensions-install";

describe("debug extensions-install", () => {
  test("installs the coordinate into the configured Mux root and prints JSON", async () => {
    const writes: string[] = [];
    const result = await runDebugExtensionInstall({
      coordinate: "/repo//ext@main",
      muxRootDir: "/tmp/mux-home",
      write: (chunk) => {
        writes.push(chunk);
      },
      install: (input) =>
        Promise.resolve({
          extensionName: "acme-review",
          resolvedSha: "a".repeat(40),
          contentHash: "sha256:abc1234567890123456789012345678901234567890",
          storePath: `${input.muxRootDir}/extensions/store/hash`,
          activePath: `${input.muxRootDir}/extensions/global/acme-review`,
        }),
    });

    expect(result.extensionName).toBe("acme-review");
    expect(JSON.parse(writes.join(""))).toEqual({
      extensionName: "acme-review",
      resolvedSha: "a".repeat(40),
      contentHash: "sha256:abc1234567890123456789012345678901234567890",
      storePath: "/tmp/mux-home/extensions/store/hash",
      activePath: "/tmp/mux-home/extensions/global/acme-review",
    });
  });
});
