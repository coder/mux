import { describe, expect, it } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";

import { createMuxMessage } from "@/common/types/message";
import { createRuntime } from "@/node/runtime/runtimeFactory";

import { injectFileAtMentions, materializeFileAtMentions } from "./fileAtMentions";

describe("injectFileAtMentions", () => {
  it("expands @file mentions from earlier user messages even when the latest has none", async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-file-at-mentions-"));

    try {
      await fsPromises.mkdir(path.join(tmpDir, "src"), { recursive: true });
      await fsPromises.writeFile(
        path.join(tmpDir, "src", "foo.ts"),
        ["line1", "line2", "line3"].join("\n"),
        "utf8"
      );

      const runtime = createRuntime({ type: "local" }, { projectPath: tmpDir });
      const messages = [
        createMuxMessage("u1", "user", "Please check @src/foo.ts"),
        createMuxMessage("a1", "assistant", "Sure."),
        createMuxMessage("u2", "user", "Now do X (no mentions)."),
      ];

      const result = await injectFileAtMentions(messages, {
        runtime,
        workspacePath: tmpDir,
      });

      // Injection should stay anchored to the *original* mention message.
      expect(result).toHaveLength(4);
      expect(result[0]?.metadata?.synthetic).toBe(true);
      expect(result[1]).toEqual(messages[0]);
      expect(result[2]).toEqual(messages[1]);
      expect(result[3]).toEqual(messages[2]);

      const injectedText = result[0]?.parts.find((p) => p.type === "text")?.text ?? "";
      expect(injectedText).toContain('<mux-file path="src/foo.ts"');
      expect(injectedText).toContain("line1");
      expect(injectedText).toContain("line2");
      expect(injectedText).toContain("line3");
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });
  it("prioritizes the latest @file mention when the global cap is hit", async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-file-at-mentions-"));

    try {
      await fsPromises.mkdir(path.join(tmpDir, "src"), { recursive: true });

      for (let i = 1; i <= 11; i++) {
        await fsPromises.writeFile(path.join(tmpDir, "src", `f${i}.ts`), `line${i}`, "utf8");
      }

      const runtime = createRuntime({ type: "local" }, { projectPath: tmpDir });
      const messages = Array.from({ length: 11 }, (_, idx) => {
        const i = idx + 1;
        return createMuxMessage(`u${i}`, "user", `Please check @src/f${i}.ts`);
      });

      const result = await injectFileAtMentions(messages, {
        runtime,
        workspacePath: tmpDir,
      });

      const syntheticMessages = result.filter((m) => m.metadata?.synthetic === true);
      expect(syntheticMessages).toHaveLength(10);

      const injectedText = syntheticMessages
        .map((m) => m.parts.find((p) => p.type === "text")?.text ?? "")
        .join("\n\n");
      expect(injectedText).toContain('<mux-file path="src/f11.ts"');
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

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

  it("skips tokens that already have persisted snapshots (fileAtMentionSnapshot metadata)", async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-file-at-mentions-"));

    try {
      await fsPromises.mkdir(path.join(tmpDir, "src"), { recursive: true });
      await fsPromises.writeFile(
        path.join(tmpDir, "src", "foo.ts"),
        ["new line1", "new line2"].join("\n"),
        "utf8"
      );

      const runtime = createRuntime({ type: "local" }, { projectPath: tmpDir });

      // Simulate a message that has already-materialized snapshot
      const snapshotMessage = createMuxMessage(
        "snapshot-1",
        "user",
        '<mux-file path="src/foo.ts" range="L1-L2">\n```ts\nold line1\nold line2\n```\n</mux-file>',
        {
          timestamp: Date.now(),
          synthetic: true,
          fileAtMentionSnapshot: ["src/foo.ts"], // Token that was materialized
        }
      );
      const userMessage = createMuxMessage("u1", "user", "Please check @src/foo.ts");
      const messages = [snapshotMessage, userMessage];

      const result = await injectFileAtMentions(messages, {
        runtime,
        workspacePath: tmpDir,
      });

      // Should NOT inject a new synthetic message because the token was already materialized
      // The messages should remain unchanged (snapshot + user message)
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(snapshotMessage);
      expect(result[1]).toEqual(userMessage);

      // Verify the old content is preserved (not re-read from the file)
      const snapshotText = result[0]?.parts.find((p) => p.type === "text")?.text ?? "";
      expect(snapshotText).toContain("old line1");
      expect(snapshotText).not.toContain("new line1");
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("materializeFileAtMentions", () => {
  it("materializes @file mentions into snapshot blocks", async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-materialize-"));

    try {
      await fsPromises.mkdir(path.join(tmpDir, "src"), { recursive: true });
      await fsPromises.writeFile(
        path.join(tmpDir, "src", "foo.ts"),
        ["line1", "line2", "line3"].join("\n"),
        "utf8"
      );

      const runtime = createRuntime({ type: "local" }, { projectPath: tmpDir });

      const result = await materializeFileAtMentions("Please check @src/foo.ts", {
        runtime,
        workspacePath: tmpDir,
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.token).toBe("src/foo.ts");
      expect(result[0]?.resolvedPath).toBe(path.join(tmpDir, "src", "foo.ts"));
      expect(result[0]?.block).toContain('<mux-file path="src/foo.ts"');
      expect(result[0]?.block).toContain("line1");
      expect(result[0]?.block).toContain("line2");
      expect(result[0]?.content).toBe("line1\nline2\nline3");
      expect(typeof result[0]?.modifiedTimeMs).toBe("number");
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("materializes line range mentions", async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-materialize-"));

    try {
      await fsPromises.mkdir(path.join(tmpDir, "src"), { recursive: true });
      await fsPromises.writeFile(
        path.join(tmpDir, "src", "foo.ts"),
        ["line1", "line2", "line3", "line4"].join("\n"),
        "utf8"
      );

      const runtime = createRuntime({ type: "local" }, { projectPath: tmpDir });

      const result = await materializeFileAtMentions("Check @src/foo.ts#L2-3", {
        runtime,
        workspacePath: tmpDir,
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.token).toBe("src/foo.ts#L2-3");
      expect(result[0]?.block).toContain('range="L2-L3"');
      expect(result[0]?.block).toContain("line2");
      expect(result[0]?.block).toContain("line3");
      expect(result[0]?.block).not.toContain("line1");
      expect(result[0]?.block).not.toContain("line4");
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty array when no @file mentions found", async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-materialize-"));

    try {
      const runtime = createRuntime({ type: "local" }, { projectPath: tmpDir });

      const result = await materializeFileAtMentions("No file mentions here", {
        runtime,
        workspacePath: tmpDir,
      });

      expect(result).toHaveLength(0);
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns error block for non-existent files", async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-materialize-"));

    try {
      const runtime = createRuntime({ type: "local" }, { projectPath: tmpDir });

      const result = await materializeFileAtMentions("Check @src/nonexistent.ts", {
        runtime,
        workspacePath: tmpDir,
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.token).toBe("src/nonexistent.ts");
      expect(result[0]?.block).toContain("<mux-file-error");
      expect(result[0]?.content).toBeUndefined();
      expect(result[0]?.modifiedTimeMs).toBeUndefined();
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
