import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { Config } from "@/node/config";
import { createDevToolsMiddleware } from "@/node/services/devToolsMiddleware";
import { DevToolsService } from "@/node/services/devToolsService";

function createTestConfig(opts: { sessionsDir: string; enabled?: boolean }): Config {
  const config = new Config(opts.sessionsDir);
  spyOn(config, "getSessionDir").mockImplementation((workspaceId: string) =>
    path.join(opts.sessionsDir, workspaceId)
  );
  spyOn(config, "getLlmDebugLogsEnabled").mockImplementation(() => opts.enabled ?? true);
  return config;
}

function createMockModel(overrides: Partial<LanguageModelV3> = {}): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "test-provider",
    modelId: "test-model",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("createMockModel.doGenerate should not be called in tests");
    },
    doStream: async () => {
      throw new Error("createMockModel.doStream should not be called in tests");
    },
    ...overrides,
  };
}

function createMockParams(): LanguageModelV3CallOptions {
  return {
    prompt: [
      {
        role: "system",
        content: "Be concise",
      },
      {
        role: "user",
        content: [{ type: "text", text: "Hello middleware" }],
      },
    ],
    maxOutputTokens: 128,
    temperature: 0.7,
    toolChoice: { type: "auto" },
    providerOptions: {
      test: {
        debug: true,
      },
    },
  };
}

function createUsage(inputTokens: number, outputTokens: number): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens,
      cacheRead: 0,
      cacheWrite: 0,
    },
    outputTokens: {
      total: outputTokens,
      text: outputTokens,
      reasoning: 0,
    },
  };
}

function createGenerateResult(
  overrides: Partial<LanguageModelV3GenerateResult> = {}
): LanguageModelV3GenerateResult {
  return {
    content: [{ type: "text", text: "Hello" }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: createUsage(10, 5),
    warnings: [],
    request: { body: "test-req" },
    response: { body: "test-resp" },
    ...overrides,
  };
}

function getWrapGenerate(middleware: LanguageModelV3Middleware) {
  if (!middleware.wrapGenerate) {
    throw new Error("Expected wrapGenerate to be defined");
  }

  return middleware.wrapGenerate;
}

function getWrapStream(middleware: LanguageModelV3Middleware) {
  if (!middleware.wrapStream) {
    throw new Error("Expected wrapStream to be defined");
  }

  return middleware.wrapStream;
}

async function collectStream(
  stream: ReadableStream<LanguageModelV3StreamPart>
): Promise<LanguageModelV3StreamPart[]> {
  const reader = stream.getReader();
  const chunks: LanguageModelV3StreamPart[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    chunks.push(value);
  }

  return chunks;
}

describe("createDevToolsMiddleware", () => {
  let tempDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-devtools-middleware-test-"));
    sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("wrapGenerate", () => {
    it("records a run + step for successful generate calls", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service);
      const wrapGenerate = getWrapGenerate(middleware);
      const model = createMockModel();
      const params = createMockParams();
      const expectedResult = createGenerateResult();

      const result = await wrapGenerate({
        doGenerate: async () => expectedResult,
        doStream: async () => {
          throw new Error("doStream should not be called");
        },
        params,
        model,
      });

      expect(result).toBe(expectedResult);

      const runs = await service.getRuns("ws-1");
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        workspaceId: "ws-1",
        stepCount: 1,
      });

      const runWithSteps = await service.getRunWithSteps("ws-1", runs[0]!.id);
      expect(runWithSteps).not.toBeNull();
      expect(runWithSteps?.steps).toHaveLength(1);

      const step = runWithSteps?.steps[0];
      expect(step).toBeDefined();
      expect(step?.type).toBe("generate");
      expect(step?.modelId).toBe("test-model");
      expect(step?.provider).toBe("test-provider");
      expect(step?.durationMs).not.toBeNull();
      expect(step?.durationMs).toBeGreaterThanOrEqual(0);
      expect(step?.input).toMatchObject({
        maxOutputTokens: 128,
        temperature: 0.7,
        toolChoice: { type: "auto" },
      });
      expect(step?.output).toEqual({
        content: expectedResult.content,
        finishReason: "stop",
        toolCalls: undefined,
      });
      expect(step?.usage).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      });
      expect(step?.rawRequest).toEqual(expectedResult.request);
      expect(step?.rawResponse).toEqual(expectedResult.response);
      expect(step?.error).toBeNull();
    });

    it("records error when doGenerate throws and rethrows", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service);
      const wrapGenerate = getWrapGenerate(middleware);
      const failure = new Error("generate failed");

      await expect(
        wrapGenerate({
          doGenerate: async () => {
            throw failure;
          },
          doStream: async () => {
            throw new Error("doStream should not be called");
          },
          params: createMockParams(),
          model: createMockModel(),
        })
      ).rejects.toThrow("generate failed");

      const runs = await service.getRuns("ws-1");
      expect(runs).toHaveLength(1);

      const runWithSteps = await service.getRunWithSteps("ws-1", runs[0]!.id);
      expect(runWithSteps).not.toBeNull();
      expect(runWithSteps?.steps).toHaveLength(1);

      const step = runWithSteps?.steps[0];
      expect(step?.error).toBe("generate failed");
      expect(step?.durationMs).not.toBeNull();
      expect(step?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("passes through result unmodified", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service);
      const wrapGenerate = getWrapGenerate(middleware);
      const expectedResult = createGenerateResult();

      const result = await wrapGenerate({
        doGenerate: async () => expectedResult,
        doStream: async () => {
          throw new Error("doStream should not be called");
        },
        params: createMockParams(),
        model: createMockModel(),
      });

      expect(result).toBe(expectedResult);
    });

    it("is a no-op when service is disabled", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: false }));
      const middleware = createDevToolsMiddleware("ws-1", service);
      const wrapGenerate = getWrapGenerate(middleware);
      const expectedResult = createGenerateResult();
      let callCount = 0;

      const result = await wrapGenerate({
        doGenerate: async () => {
          callCount += 1;
          return expectedResult;
        },
        doStream: async () => {
          throw new Error("doStream should not be called");
        },
        params: createMockParams(),
        model: createMockModel(),
      });

      expect(callCount).toBe(1);
      expect(result).toBe(expectedResult);
      expect(await service.getRuns("ws-1")).toEqual([]);
    });
  });

  describe("wrapStream", () => {
    it("records a run + step and collects streamed text output on flush", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service);
      const wrapStream = getWrapStream(middleware);

      const chunks: LanguageModelV3StreamPart[] = [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Hello " },
        { type: "text-delta", id: "t1", delta: "world" },
        { type: "text-end", id: "t1" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: createUsage(5, 2),
        },
      ];

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });

      const result = await wrapStream({
        doGenerate: async () => {
          throw new Error("doGenerate should not be called");
        },
        doStream: async () => ({
          stream,
          request: { body: "stream-req" },
          response: { headers: { "x-test": "1" } },
        }),
        params: createMockParams(),
        model: createMockModel(),
      });

      const observedChunks = await collectStream(result.stream);
      expect(observedChunks).toEqual(chunks);

      const runs = await service.getRuns("ws-1");
      expect(runs).toHaveLength(1);

      const runWithSteps = await service.getRunWithSteps("ws-1", runs[0]!.id);
      expect(runWithSteps).not.toBeNull();
      expect(runWithSteps?.steps).toHaveLength(1);

      const step = runWithSteps?.steps[0];
      expect(step?.type).toBe("stream");
      expect(step?.output).toEqual({
        textParts: [{ id: "t1", text: "Hello world" }],
        reasoningParts: [],
        toolCalls: [],
        finishReason: "stop",
      });
      expect(step?.usage).toEqual({
        inputTokens: 5,
        outputTokens: 2,
        totalTokens: 7,
      });
      expect(step?.rawRequest).toEqual({ body: "stream-req" });
      expect(step?.rawResponse).toEqual({ headers: { "x-test": "1" } });
      expect(step?.error).toBeNull();
    });

    it("records tool calls from stream chunks", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service);
      const wrapStream = getWrapStream(middleware);

      const chunks: LanguageModelV3StreamPart[] = [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "weather",
          input: '{"city":"SF"}',
        },
        {
          type: "finish",
          finishReason: { unified: "tool-calls", raw: "tool-calls" },
          usage: createUsage(8, 3),
        },
      ];

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });

      const result = await wrapStream({
        doGenerate: async () => {
          throw new Error("doGenerate should not be called");
        },
        doStream: async () => ({ stream }),
        params: createMockParams(),
        model: createMockModel(),
      });

      await collectStream(result.stream);

      const runs = await service.getRuns("ws-1");
      const runWithSteps = await service.getRunWithSteps("ws-1", runs[0]!.id);
      expect(runWithSteps).not.toBeNull();

      const step = runWithSteps?.steps[0];
      expect(step?.output).toMatchObject({
        toolCalls: [
          {
            toolCallId: "call-1",
            toolName: "weather",
            args: '{"city":"SF"}',
          },
        ],
        finishReason: "tool-calls",
      });
    });

    it("records 'Request aborted' on stream cancel", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service);
      const wrapStream = getWrapStream(middleware);

      const neverEndingStream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: "partial" });
        },
      });

      const result = await wrapStream({
        doGenerate: async () => {
          throw new Error("doGenerate should not be called");
        },
        doStream: async () => ({ stream: neverEndingStream }),
        params: createMockParams(),
        model: createMockModel(),
      });

      const reader = result.stream.getReader();
      await reader.read();
      await reader.cancel();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const runs = await service.getRuns("ws-1");
      const runWithSteps = await service.getRunWithSteps("ws-1", runs[0]!.id);
      expect(runWithSteps).not.toBeNull();

      const step = runWithSteps?.steps[0];
      expect(step?.error).toBe("Request aborted");
      expect(step?.durationMs).not.toBeNull();
      expect(step?.output).toEqual({
        textParts: [],
        reasoningParts: [],
        toolCalls: [],
        finishReason: undefined,
      });
    });

    it("multiple steps in one middleware instance share the same runId", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service);
      const wrapGenerate = getWrapGenerate(middleware);

      await wrapGenerate({
        doGenerate: async () => createGenerateResult({ response: { body: "first" } }),
        doStream: async () => {
          throw new Error("doStream should not be called");
        },
        params: createMockParams(),
        model: createMockModel(),
      });

      await wrapGenerate({
        doGenerate: async () => createGenerateResult({ response: { body: "second" } }),
        doStream: async () => {
          throw new Error("doStream should not be called");
        },
        params: createMockParams(),
        model: createMockModel(),
      });

      const runs = await service.getRuns("ws-1");
      expect(runs).toHaveLength(1);
      expect(runs[0]?.stepCount).toBe(2);

      const runWithSteps = await service.getRunWithSteps("ws-1", runs[0]!.id);
      expect(runWithSteps).not.toBeNull();
      expect(runWithSteps?.steps).toHaveLength(2);

      const firstStep = runWithSteps?.steps[0];
      const secondStep = runWithSteps?.steps[1];
      expect(firstStep?.runId).toBe(secondStep?.runId);
      expect(firstStep?.stepNumber).toBe(1);
      expect(secondStep?.stepNumber).toBe(2);
    });
  });
});
