import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ExecResult } from "@/node/utils/runtime/helpers";
import * as runtimeHelpers from "@/node/utils/runtime/helpers";
import { createWebFetchTool } from "./web_fetch";
import type { WebFetchToolArgs, WebFetchToolResult } from "@/common/types/tools";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import { isMuxMdUrl, parseMuxMdUrl, uploadToMuxMd, deleteFromMuxMd } from "@/common/lib/muxMd";
import type { ToolExecutionOptions } from "ai";

const itIntegration = process.env.TEST_INTEGRATION === "1" ? it : it.skip;
const toolCallOptions: ToolExecutionOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

function createTestWebFetchTool() {
  const tempDir = new TestTempDir("test-web-fetch");
  const config = createTestToolConfig(tempDir.path);
  const tool = createWebFetchTool(config);

  return {
    tool,
    tempDir,
    [Symbol.dispose]() {
      tempDir[Symbol.dispose]();
    },
  };
}

function createExecResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    duration: 1,
    ...overrides,
  };
}

function isCurlCommand(command: string): boolean {
  return command.startsWith("curl ");
}

function isRuntimeResolveCommand(command: string): boolean {
  return command.startsWith("if command -v python3 >/dev/null 2>&1; then");
}

afterEach(() => {
  mock.restore();
});

describe("mux.md URL helpers", () => {
  describe("isMuxMdUrl", () => {
    it("should detect valid mux.md URLs", () => {
      expect(isMuxMdUrl("https://mux.md/abc123#key456")).toBe(true);
      expect(isMuxMdUrl("https://mux.md/RQJe3#Fbbhosspt9q9Ig")).toBe(true);
    });

    it("should reject mux.md URLs without hash", () => {
      expect(isMuxMdUrl("https://mux.md/abc123")).toBe(false);
    });

    it("should reject mux.md URLs with empty hash", () => {
      expect(isMuxMdUrl("https://mux.md/abc123#")).toBe(false);
    });

    it("should reject non-mux.md URLs", () => {
      expect(isMuxMdUrl("https://example.com/page#hash")).toBe(false);
      expect(isMuxMdUrl("https://other.md/abc#key")).toBe(false);
    });

    it("should handle invalid URLs gracefully", () => {
      expect(isMuxMdUrl("not-a-url")).toBe(false);
      expect(isMuxMdUrl("")).toBe(false);
    });
  });

  describe("parseMuxMdUrl", () => {
    it("should extract id and key from valid mux.md URL", () => {
      const result = parseMuxMdUrl("https://mux.md/abc123#key456");
      expect(result).toEqual({ id: "abc123", key: "key456" });
    });

    it("should handle base64url characters in key", () => {
      const result = parseMuxMdUrl("https://mux.md/RQJe3#Fbbhosspt9q9Ig");
      expect(result).toEqual({ id: "RQJe3", key: "Fbbhosspt9q9Ig" });
    });

    it("should return null for URLs without hash", () => {
      expect(parseMuxMdUrl("https://mux.md/abc123")).toBeNull();
    });

    it("should return null for URLs with empty id", () => {
      expect(parseMuxMdUrl("https://mux.md/#key")).toBeNull();
    });

    it("should return null for invalid URLs", () => {
      expect(parseMuxMdUrl("not-a-url")).toBeNull();
    });
  });
});

describe("web_fetch tool", () => {
  itIntegration("should fetch and convert a real web page to markdown", async () => {
    using testEnv = createTestWebFetchTool();
    const args: WebFetchToolArgs = {
      url: "https://example.com",
    };

    const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.title).toContain("Example Domain");
      expect(result.url).toBe("https://example.com");
      expect(result.content).toContain("documentation");
      expect(result.length).toBeGreaterThan(0);
    }
  });

  itIntegration("should fetch plain text content without HTML processing", async () => {
    using testEnv = createTestWebFetchTool();
    const args: WebFetchToolArgs = {
      url: "https://cloudflare.com/cdn-cgi/trace",
    };

    const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toContain("fl=");
      expect(result.content).toContain("h=");
      expect(result.content).toContain("ip=");
      expect(result.title).toBe("https://cloudflare.com/cdn-cgi/trace");
      expect(result.length).toBeGreaterThan(0);
    }
  });

  itIntegration("should handle DNS failure gracefully", async () => {
    using testEnv = createTestWebFetchTool();
    const args: WebFetchToolArgs = {
      url: "https://this-domain-does-not-exist.invalid/page",
    };

    const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Failed to fetch URL");
    }
  });

  it.each(["file:///tmp/secret.txt", "data:text/plain,hello", "javascript:alert(1)"])(
    "rejects non-http(s) URLs: %s",
    async (url: string) => {
      using testEnv = createTestWebFetchTool();

      const execSpy = spyOn(runtimeHelpers, "execBuffered");
      const result = (await testEnv.tool.execute!({ url }, toolCallOptions)) as WebFetchToolResult;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Blocked URL");
        expect(result.error).toContain("http:// and https://");
      }
      expect(execSpy).not.toHaveBeenCalled();
    }
  );

  it.each([
    "http://localhost/page",
    "http://127.0.0.1/page",
    "http://0.0.0.0/page",
    "http://[::1]/page",
    "http://10.0.0.1/page",
    "http://172.16.0.1/page",
    "http://192.168.1.10/page",
    "http://169.254.169.254/latest/meta-data",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://[::ffff:127.0.0.1]/page",
    "http://[::ffff:192.168.1.1]/page",
    "http://[::ffff:169.254.169.254]/latest/meta-data",
  ])("rejects blocked internal targets: %s", async (url: string) => {
    using testEnv = createTestWebFetchTool();

    const execSpy = spyOn(runtimeHelpers, "execBuffered");
    const result = (await testEnv.tool.execute!({ url }, toolCallOptions)) as WebFetchToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Blocked URL");
      expect(result.error).toContain("internal network targets");
    }
    expect(execSpy).not.toHaveBeenCalled();
  });

  it("rejects hostnames whose runtime resolution returns private addresses", async () => {
    using testEnv = createTestWebFetchTool();

    const execSpy = spyOn(runtimeHelpers, "execBuffered").mockResolvedValue(
      createExecResult({ stdout: '["10.0.0.5"]' })
    );

    const result = (await testEnv.tool.execute!(
      { url: "https://public.example/article" },
      toolCallOptions
    )) as WebFetchToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Blocked URL");
      expect(result.error).toContain("internal network targets");
    }
    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(isRuntimeResolveCommand(execSpy.mock.calls[0]?.[1] ?? "")).toBe(true);
    expect(execSpy.mock.calls.some(([, command]) => isCurlCommand(command))).toBe(false);
  });

  it.each([
    {
      name: "resolver failure",
      execResult: createExecResult({ exitCode: 1, stderr: "lookup failed" }),
    },
    {
      name: "empty resolver output",
      execResult: createExecResult({ stdout: "   " }),
    },
    {
      name: "unparseable resolver output",
      execResult: createExecResult({ stdout: "not-json" }),
    },
  ])("fails closed on $name", async ({ execResult }) => {
    using testEnv = createTestWebFetchTool();

    const execSpy = spyOn(runtimeHelpers, "execBuffered").mockResolvedValue(execResult);

    const result = (await testEnv.tool.execute!(
      { url: "https://public.example/article" },
      toolCallOptions
    )) as WebFetchToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Failed to fetch URL: Could not resolve host");
    }
    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(isRuntimeResolveCommand(execSpy.mock.calls[0]?.[1] ?? "")).toBe(true);
    expect(execSpy.mock.calls.some(([, command]) => isCurlCommand(command))).toBe(false);
  });

  it("validates public hostnames through the runtime before fetching", async () => {
    using testEnv = createTestWebFetchTool();

    const execSpy = spyOn(runtimeHelpers, "execBuffered").mockImplementation(
      async (_runtime, command) => {
        if (isRuntimeResolveCommand(command)) {
          expect(command).toContain("public.example");
          return createExecResult({ stdout: '["93.184.216.34"]' });
        }

        expect(isCurlCommand(command)).toBe(true);
        expect(command).toContain("https://public.example/article");
        return createExecResult({
          stdout:
            "HTTP/1.1 200 OK\r\n" +
            "Content-Type: text/html; charset=utf-8\r\n\r\n" +
            "<!DOCTYPE html><html><head><title>Runtime Resolved</title></head><body><article><h1>Resolved</h1><p>Fetched after runtime validation.</p></article></body></html>",
        });
      }
    );

    const result = (await testEnv.tool.execute!(
      { url: "https://public.example/article" },
      toolCallOptions
    )) as WebFetchToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.title).toBe("Runtime Resolved");
      expect(result.content).toContain("Fetched after runtime validation.");
    }
    expect(execSpy).toHaveBeenCalledTimes(2);
    expect(isRuntimeResolveCommand(execSpy.mock.calls[0]?.[1] ?? "")).toBe(true);
    expect(isCurlCommand(execSpy.mock.calls[1]?.[1] ?? "")).toBe(true);
  });

  it("revalidates redirect hostnames through the runtime before following them", async () => {
    using testEnv = createTestWebFetchTool();

    const execSpy = spyOn(runtimeHelpers, "execBuffered").mockImplementation(
      async (_runtime, command) => {
        if (isRuntimeResolveCommand(command) && command.includes("public.example")) {
          return createExecResult({ stdout: '["93.184.216.34"]' });
        }
        if (isCurlCommand(command)) {
          return createExecResult({
            stdout:
              "HTTP/1.1 302 Found\r\n" +
              "Location: https://redirect.example/private\r\n" +
              "Content-Type: text/plain\r\n\r\n",
          });
        }
        if (isRuntimeResolveCommand(command) && command.includes("redirect.example")) {
          return createExecResult({ stdout: '["10.0.0.5"]' });
        }

        throw new Error(`Unexpected command: ${command}`);
      }
    );

    const result = (await testEnv.tool.execute!(
      { url: "https://public.example/start" },
      toolCallOptions
    )) as WebFetchToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Blocked URL");
      expect(result.error).toContain("internal network targets");
    }
    expect(execSpy).toHaveBeenCalledTimes(3);
    expect(isRuntimeResolveCommand(execSpy.mock.calls[0]?.[1] ?? "")).toBe(true);
    expect(isCurlCommand(execSpy.mock.calls[1]?.[1] ?? "")).toBe(true);
    expect(isRuntimeResolveCommand(execSpy.mock.calls[2]?.[1] ?? "")).toBe(true);
  });

  it("does not use runtime hostname resolution for public IP literals", async () => {
    using testEnv = createTestWebFetchTool();

    const execSpy = spyOn(runtimeHelpers, "execBuffered").mockImplementation(
      async (_runtime, command) => {
        expect(isCurlCommand(command)).toBe(true);
        expect(command).toContain("https://93.184.216.34/article");
        return createExecResult({
          stdout:
            "HTTP/1.1 200 OK\r\n" +
            "Content-Type: text/html; charset=utf-8\r\n\r\n" +
            "<!DOCTYPE html><html><head><title>IP Literal</title></head><body><article><h1>Literal</h1><p>No runtime DNS lookup.</p></article></body></html>",
        });
      }
    );

    const result = (await testEnv.tool.execute!(
      { url: "https://93.184.216.34/article" },
      toolCallOptions
    )) as WebFetchToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.title).toBe("IP Literal");
      expect(result.content).toContain("No runtime DNS lookup.");
    }
    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(isCurlCommand(execSpy.mock.calls[0]?.[1] ?? "")).toBe(true);
  });

  it("follows validated public redirects and returns the final content", async () => {
    using testEnv = createTestWebFetchTool();

    const execSpy = spyOn(runtimeHelpers, "execBuffered")
      .mockResolvedValueOnce({
        stdout:
          "HTTP/1.1 302 Found\r\n" +
          "Location: https://93.184.216.35/final\r\n" +
          "Content-Type: text/plain\r\n\r\n",
        stderr: "",
        exitCode: 0,
        duration: 1,
      })
      .mockResolvedValueOnce({
        stdout:
          "HTTP/1.1 200 OK\r\n" +
          "Content-Type: text/html; charset=utf-8\r\n\r\n" +
          "<!DOCTYPE html><html><head><title>Redirected Page</title></head><body><article><h1>Redirected</h1><p>Public content.</p></article></body></html>",
        stderr: "",
        exitCode: 0,
        duration: 1,
      });

    const result = (await testEnv.tool.execute!(
      { url: "https://93.184.216.34/start" },
      toolCallOptions
    )) as WebFetchToolResult;

    expect(execSpy).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.title).toBe("Redirected Page");
      expect(result.content).toContain("Public content.");
    }
  });

  it("does not treat non-mux.md URLs with fragments as mux.md shares", async () => {
    using testEnv = createTestWebFetchTool();

    spyOn(runtimeHelpers, "execBuffered").mockResolvedValue({
      stdout:
        "HTTP/1.1 200 OK\r\n" +
        "Content-Type: text/html; charset=utf-8\r\n\r\n" +
        "<!DOCTYPE html><html><head><title>Fragment Page</title></head><body><article><h1>Hello</h1><p>This is a fragment test.</p></article></body></html>",
      stderr: "",
      exitCode: 0,
      duration: 1,
    });

    const result = (await testEnv.tool.execute!(
      { url: "https://93.184.216.34/page#section1" },
      toolCallOptions
    )) as WebFetchToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.title).toBe("Fragment Page");
      expect(result.content).toContain("This is a fragment test.");
    }
  });

  itIntegration("should include HTTP status code in error for non-2xx responses", async () => {
    using testEnv = createTestWebFetchTool();
    const args: WebFetchToolArgs = {
      url: "https://httpbin.dev/status/404",
    };

    const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("HTTP 404");
    }
  });

  itIntegration("should detect Cloudflare challenge pages", async () => {
    using testEnv = createTestWebFetchTool();
    const args: WebFetchToolArgs = {
      url: "https://platform.openai.com",
    };

    const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Cloudflare");
      expect(result.error).toContain("JavaScript");
    }
  });

  itIntegration("should handle expired/missing mux.md share links", async () => {
    using testEnv = createTestWebFetchTool();
    const args: WebFetchToolArgs = {
      url: "https://mux.md/nonexistent123#somekey456",
    };

    const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("expired or not found");
    }
  });

  it("should return error for mux.md URLs without valid key format", async () => {
    using testEnv = createTestWebFetchTool();
    const args: WebFetchToolArgs = {
      url: "https://mux.md/someid",
    };

    const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid mux.md URL format");
    }
  });

  itIntegration("should decrypt and return mux.md content correctly", async () => {
    using testEnv = createTestWebFetchTool();

    const testContent = "# Test Heading\n\nThis is **test content** for web_fetch decryption.";
    const uploadResult = await uploadToMuxMd(
      testContent,
      { name: "test.md", type: "text/markdown", size: testContent.length },
      { expiresAt: new Date(Date.now() + 60000) }
    );

    try {
      const args: WebFetchToolArgs = { url: uploadResult.url };
      const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toBe(testContent);
        expect(result.title).toBe("test.md");
        expect(result.url).toBe(uploadResult.url);
        expect(result.length).toBe(testContent.length);
      }
    } finally {
      await deleteFromMuxMd(uploadResult.id, uploadResult.mutateKey);
    }
  });
});
