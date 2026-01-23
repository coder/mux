import { generateObject, generateText } from "ai";

import { buildProviderOptions } from "../../src/common/utils/ai/providerOptions";
import { getThinkingPolicyForModel } from "../../src/common/utils/thinking/policy";
import { THINKING_LEVELS, type ThinkingLevel } from "../../src/common/types/thinking";
import {
  applySystem1KeepRangesToOutput,
  buildSystem1BashKeepRangesPrompt,
  formatNumberedLinesForSystem1,
  parseSystem1KeepRanges,
  splitBashOutputLines,
  system1BashKeepRangesSchema,
} from "../../src/node/services/system1/bashOutputFiltering";

import {
  cleanupTestEnvironment,
  createTestEnvironment,
  preloadTestModules,
  setupProviders,
  shouldRunIntegrationTests,
  type TestEnvironment,
} from "./setup";

function parseModelString(modelString: string): { provider: string; modelId: string } | null {
  const [provider, modelId] = modelString.split(":", 2);
  if (!provider || !modelId) {
    return null;
  }
  return { provider, modelId };
}

function pickThinkingLevels(levels: readonly ThinkingLevel[]): ThinkingLevel[] {
  const normalized = [...levels];

  if (normalized.length <= 2) {
    return normalized;
  }

  const min = normalized[0];
  const mid = normalized[Math.floor(normalized.length / 2)];
  const max = normalized[normalized.length - 1];

  const picked: ThinkingLevel[] = [];
  for (const level of [min, mid, max]) {
    if (!picked.includes(level)) {
      picked.push(level);
    }
  }
  return picked;
}

function resolveApiKeyForProvider(provider: string): string | null {
  if (provider === "anthropic") {
    return process.env.ANTHROPIC_API_KEY ?? null;
  }
  if (provider === "openai") {
    return process.env.OPENAI_API_KEY ?? null;
  }
  if (provider === "google") {
    return process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GOOGLE_API_KEY ?? null;
  }
  return null;
}

const DEFAULT_MODELS = [
  "google:gemini-3-flash-preview",
  "anthropic:claude-haiku-4-5",
  "openai:gpt-5.1-codex-mini",
];

const requestedModels = (
  process.env.SYSTEM1_BASH_COMPACTION_TEST_MODELS
    ? process.env.SYSTEM1_BASH_COMPACTION_TEST_MODELS.split(",")
    : DEFAULT_MODELS
)
  .map((m) => m.trim())
  .filter((m) => m.length > 0);

const configuredModels = requestedModels.filter((modelString) => {
  const parsed = parseModelString(modelString);
  if (!parsed) {
    return false;
  }

  const apiKey = resolveApiKeyForProvider(parsed.provider);
  if (!apiKey) {
    // eslint-disable-next-line no-console
    console.warn(
      `Skipping System1 bash compaction integration test for ${modelString}: missing API key env vars for provider ${parsed.provider}`
    );
    return false;
  }

  return true;
});

const shouldRunSuite = shouldRunIntegrationTests() && configuredModels.length > 0;
const describeIntegration = shouldRunSuite ? describe : describe.skip;

if (shouldRunIntegrationTests() && !shouldRunSuite) {
  // eslint-disable-next-line no-console
  console.warn(
    "Skipping System1 bash compaction integration tests: no configured models (missing API keys)"
  );
}

const TEST_TIMEOUT_MS = 60_000;

const ERROR_MARKER = "MUX_SYSTEM1_KEEP_RANGES_TEST_ERROR_MARKER";
const RAW_OUTPUT = [
  "running...",
  "some noise line 1",
  "some noise line 2",
  `ERROR: ${ERROR_MARKER}`,
  "  at path/to/file.ts:12:3",
  "exited with code 1",
].join("\n");

const SCRIPT = "bun test";
const MAX_KEPT_LINES = 40;

// This test calls real providers via generateObject() and validates that we can reliably
// obtain usable keep_ranges for bash output filtering across a model + thinking-level matrix.
describeIntegration("System1 bash output compaction (keep_ranges matrix)", () => {
  let env: TestEnvironment;

  beforeAll(async () => {
    await preloadTestModules();
    env = await createTestEnvironment();

    const providers: Record<string, { apiKey: string }> = {};
    for (const modelString of configuredModels) {
      const parsed = parseModelString(modelString);
      if (!parsed) continue;
      if (providers[parsed.provider]) continue;

      const apiKey = resolveApiKeyForProvider(parsed.provider);
      if (!apiKey) continue;

      providers[parsed.provider] = { apiKey };
    }

    await setupProviders(env, providers);
  }, 30_000);

  afterAll(async () => {
    if (env) {
      await cleanupTestEnvironment(env);
    }
  });

  for (const modelString of configuredModels) {
    test(
      `should generate keep_ranges for ${modelString}`,
      async () => {
        const modelResult = await env.services.aiService.createModel(modelString);
        expect(modelResult.success).toBe(true);
        if (!modelResult.success) {
          throw new Error(`Failed to create model ${modelString}: ${modelResult.error}`);
        }

        const lines = splitBashOutputLines(RAW_OUTPUT);
        const numberedOutput = formatNumberedLinesForSystem1(lines);
        const { systemPrompt, userMessage } = buildSystem1BashKeepRangesPrompt({
          maxKeptLines: MAX_KEPT_LINES,
          script: SCRIPT,
          numberedOutput,
        });

        const policy = getThinkingPolicyForModel(modelString);
        const allowedThinkingLevels = policy.length > 0 ? policy : THINKING_LEVELS;
        const thinkingLevels = pickThinkingLevels(allowedThinkingLevels);

        const provider = parseModelString(modelString)?.provider;

        for (const thinkingLevel of thinkingLevels) {
          const providerOptions = buildProviderOptions(
            modelString,
            thinkingLevel,
            undefined,
            undefined,
            undefined,
            "system1-test"
          ) as unknown;

          let keepRanges: Parameters<typeof applySystem1KeepRangesToOutput>[0]["keepRanges"];

          if (provider === "anthropic") {
            const result = await generateText({
              model: modelResult.data,
              system: systemPrompt,
              messages: [{ role: "user", content: userMessage }],
              providerOptions: providerOptions as Parameters<
                typeof generateText
              >[0]["providerOptions"],
              maxOutputTokens: 600,
              maxRetries: 0,
            });

            const parsedKeepRanges = parseSystem1KeepRanges(result.text);
            if (!parsedKeepRanges) {
              throw new Error(
                `Failed to parse keep_ranges from ${modelString} (${thinkingLevel}): ${result.text.slice(0, 200)}`
              );
            }

            keepRanges = parsedKeepRanges;
          } else {
            const result = await generateObject({
              model: modelResult.data,
              schema: system1BashKeepRangesSchema,
              mode: "json",
              system: systemPrompt,
              messages: [{ role: "user", content: userMessage }],
              providerOptions: providerOptions as Parameters<
                typeof generateObject
              >[0]["providerOptions"],
              maxOutputTokens: 600,
              maxRetries: 0,
            });

            keepRanges = result.object.keep_ranges;
          }

          const applied = applySystem1KeepRangesToOutput({
            rawOutput: RAW_OUTPUT,
            keepRanges,
            maxKeptLines: MAX_KEPT_LINES,
          });

          expect(applied).toBeDefined();
          expect(applied?.keptLines).toBeLessThanOrEqual(MAX_KEPT_LINES);
          expect(applied?.filteredOutput).toContain(ERROR_MARKER);
        }
      },
      TEST_TIMEOUT_MS
    );
  }
});
