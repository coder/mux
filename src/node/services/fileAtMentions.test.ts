import { describe, expect, it } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";

import { createMuxMessage } from "@/common/types/message";
import { createRuntime } from "@/node/runtime/runtimeFactory";

import { injectFileAtMentions } from "./fileAtMentions";

describe("injectFileAtMentions", () => {
  it("injects a synthetic user message with file contents before the prompt", async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-file-at-mentions-"));

    try {
      await fsPromises.mkdir(path.join(tmpDir, "src"), { recursive: true });
      await fsPromises.writeFile(
        path.join(tmpDir, "src", "foo.ts"),
        ["line1", "line2", "line3", "line4"].join("\n"),
        "utf8"
      );

      const runtime = createRuntime({ type: "local" }, { projectPath: tmpDir });
      const messages = [createMuxMessage("u1", "user", "Please check @src/foo.ts#L2-3")];

      const result = await injectFileAtMentions(messages, {
        runtime,
        workspacePath: tmpDir,
      });

      expect(result).toHaveLength(2);
      expect(result[0]?.role).toBe("user");
      expect(result[0]?.metadata?.synthetic).toBe(true);
      expect(result[1]).toEqual(messages[0]);

      const injectedText = result[0]?.parts.find((p) => p.type === "text")?.text ?? "";
      expect(injectedText).toContain('<mux-file path="src/foo.ts" range="L2-L3"');
      expect(injectedText).toContain("```ts");
      expect(injectedText).toContain("line2");
      expect(injectedText).toContain("line3");
      expect(injectedText).not.toContain("line1");
      expect(injectedText).not.toContain("line4");
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("injects root files like @Makefile", async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-file-at-mentions-"));

    try {
      await fsPromises.writeFile(
        path.join(tmpDir, "Makefile"),
        ["line1", "line2"].join("\n"),
        "utf8"
      );

      const runtime = createRuntime({ type: "local" }, { projectPath: tmpDir });
      const messages = [createMuxMessage("u1", "user", "Please check @Makefile")];

      const result = await injectFileAtMentions(messages, {
        runtime,
        workspacePath: tmpDir,
      });

      expect(result).toHaveLength(2);
      expect(result[0]?.metadata?.synthetic).toBe(true);

      const injectedText = result[0]?.parts.find((p) => p.type === "text")?.text ?? "";
      expect(injectedText).toContain('<mux-file path="Makefile" range="L1-L2"');
      expect(injectedText).toContain("line1");
      expect(injectedText).toContain("line2");
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("ignores non-file @mentions with # fragments", async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-file-at-mentions-"));

    try {
      const runtime = createRuntime({ type: "local" }, { projectPath: tmpDir });
      const messages = [createMuxMessage("u1", "user", "Ping @alice#123")];

      const result = await injectFileAtMentions(messages, {
        runtime,
        workspacePath: tmpDir,
      });

      expect(result).toEqual(messages);
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
