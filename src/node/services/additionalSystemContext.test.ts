import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  ADDITIONAL_SYSTEM_CONTEXT_FILENAME,
  mergeAdditionalSystemInstructions,
  readAdditionalSystemContext,
  writeAdditionalSystemContext,
} from "./additionalSystemContext";

function createSessionDirProvider(root: string) {
  return {
    getSessionDir: (workspaceId: string) => path.join(root, workspaceId),
  };
}

describe("additionalSystemContext", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-additional-context-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("read/write persists workspace scratchpad content", async () => {
    const config = createSessionDirProvider(tempDir);

    await writeAdditionalSystemContext(config, "workspace-1", "Remember the API contract.");

    await expect(readAdditionalSystemContext(config, "workspace-1")).resolves.toBe(
      "Remember the API contract."
    );
    await expect(
      fs.readFile(path.join(tempDir, "workspace-1", ADDITIONAL_SYSTEM_CONTEXT_FILENAME), "utf-8")
    ).resolves.toBe("Remember the API contract.");
  });

  test("empty content removes durable scratchpad file", async () => {
    const config = createSessionDirProvider(tempDir);
    const scratchpadPath = path.join(tempDir, "workspace-1", ADDITIONAL_SYSTEM_CONTEXT_FILENAME);

    await writeAdditionalSystemContext(config, "workspace-1", "temporary");
    await writeAdditionalSystemContext(config, "workspace-1", "");

    await expect(readAdditionalSystemContext(config, "workspace-1")).resolves.toBe("");
    await expect(fs.stat(scratchpadPath)).rejects.toThrow();
  });

  test("mergeAdditionalSystemInstructions appends scratchpad before request-specific instructions", () => {
    expect(mergeAdditionalSystemInstructions("scratch", "request")).toBe("scratch\n\nrequest");
    expect(mergeAdditionalSystemInstructions("scratch", "scratch\n\nrequest")).toBe(
      "scratch\n\nrequest"
    );
    expect(mergeAdditionalSystemInstructions("scratch", undefined)).toBe("scratch");
    expect(mergeAdditionalSystemInstructions("", "request")).toBe("request");
    expect(mergeAdditionalSystemInstructions("", undefined)).toBeUndefined();
  });
});
