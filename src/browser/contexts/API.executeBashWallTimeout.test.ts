import { describe, expect, mock, test } from "bun:test";

import type { APIClient } from "./API";
import { wrapExecuteBashWithWallTimeout } from "./API";

describe("wrapExecuteBashWithWallTimeout", () => {
  test("resolves with error when executeBash never settles", async () => {
    const hangingExecuteBash = mock(() => new Promise(() => undefined));

    const client = {
      workspace: {
        executeBash: hangingExecuteBash,
      },
    } as unknown as APIClient;

    wrapExecuteBashWithWallTimeout(client);

    type ExecuteBashInput = Parameters<APIClient["workspace"]["executeBash"]>[0];

    const input: ExecuteBashInput = {
      workspaceId: "w",
      script: "true",
      options: { timeout_secs: 0.05 },
    };

    const result = await client.workspace.executeBash(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("wall-timeout");
    }
  });
});
