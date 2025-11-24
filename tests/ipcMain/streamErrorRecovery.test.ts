/**
 * Stream Error Recovery Integration Tests
 *
 * These tests verify the "no amnesia" fix - ensuring that when a stream is interrupted
 * by an error (network failure, API error, etc.), the accumulated content is preserved
 * and available when the stream is resumed.
 *
 * Test Approach:
 * - Use structured markers (nonce + line numbers) to detect exact continuation
 * - Capture pre-error streamed text from stream-delta events (user-visible data path)
 * - Interrupt mid-stream after detecting stable prefix (≥N complete markers)
 * - Verify final message: (a) starts with exact pre-error prefix, (b) continues from exact point
 * - Focus on user-level behavior without coupling to internal storage formats
 *
 * These tests use a debug IPC channel to artificially trigger errors, allowing us to
 * test the recovery path without relying on actual network failures.
 */

import { setupWorkspace, shouldRunIntegrationTests, validateApiKeys } from "./setup";
import {
  sendMessageWithModel,
  createEventCollector,
  readChatHistory,
  modelString,
} from "./helpers";
import { IPC_CHANNELS } from "../../src/common/constants/ipc-constants";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

// Use Haiku 4.5 for speed
const PROVIDER = "anthropic";
const MODEL = "claude-haiku-4-5";

// Threshold for stable prefix - interrupt after this many complete markers
const STABLE_PREFIX_THRESHOLD = 10;

/**
 * Generate a random nonce for unique marker identification
 */
function generateNonce(length = 10): string {
  return Math.random()
    .toString(36)
    .substring(2, 2 + length);
}

/**
 * Extract marker numbers from text containing structured markers
 * Returns array of numbers in the order they appear
 */
function extractMarkers(nonce: string, text: string): number[] {
  const regex = new RegExp(`${nonce}-(\\d+)`, "g");
  const numbers: number[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    numbers.push(parseInt(match[1], 10));
  }
  return numbers;
}

/**
 * Get the maximum complete marker number found in text
 */
function getMaxMarker(nonce: string, text: string): number {
  const markers = extractMarkers(nonce, text);
  return markers.length > 0 ? Math.max(...markers) : 0;
}

/**
 * Truncate text to end at the last complete marker line
 * This ensures the stable prefix doesn't include partial markers
 */
function truncateToLastCompleteMarker(text: string, nonce: string): string {
  const regex = new RegExp(`${nonce}-(\\d+):[^\\n]*`, "g");
  const matches = Array.from(text.matchAll(regex));
  if (matches.length === 0) {
    return text;
  }
  const lastMatch = matches[matches.length - 1];
  const endIndex = lastMatch.index! + lastMatch[0].length;
  return text.substring(0, endIndex);
}

/**
 * Helper: Trigger an error in an active stream
 */
async function triggerStreamError(
  mockIpcRenderer: unknown,
  workspaceId: string,
  errorMessage: string
): Promise<void> {
  const result = await (
    mockIpcRenderer as {
      invoke: (
        channel: string,
        ...args: unknown[]
      ) => Promise<{ success: boolean; error?: string }>;
    }
  ).invoke(IPC_CHANNELS.DEBUG_TRIGGER_STREAM_ERROR, workspaceId, errorMessage);
  if (!result.success) {
    throw new Error(
      `Failed to trigger stream error: ${errorMessage}. Reason: ${result.error || "unknown"}`
    );
  }
}

/**
 * Helper: Resume stream and wait for successful completion
 * Filters out pre-resume error events to detect only new errors
 */
async function resumeAndWaitForSuccess(
  mockIpcRenderer: unknown,
  workspaceId: string,
  sentEvents: Array<{ channel: string; data: unknown }>,
  model: string,
  timeoutMs = 15000
): Promise<void> {
  // Capture event count before resume to filter old error events
  const eventCountBeforeResume = sentEvents.length;

  const resumeResult = await (
    mockIpcRenderer as {
      invoke: (
        channel: string,
        ...args: unknown[]
      ) => Promise<{ success: boolean; error?: string }>;
    }
  ).invoke(IPC_CHANNELS.WORKSPACE_RESUME_STREAM, workspaceId, { model });

  if (!resumeResult.success) {
    throw new Error(`Resume failed: ${resumeResult.error}`);
  }

  // Wait for stream-end event after resume
  const collector = createEventCollector(sentEvents, workspaceId);
  const streamEnd = await collector.waitForEvent("stream-end", timeoutMs);

  if (!streamEnd) {
    throw new Error("Stream did not complete after resume");
  }

  // Check that the resumed stream itself didn't error (ignore previous errors)
  const eventsAfterResume = sentEvents.slice(eventCountBeforeResume);
  const chatChannel = `chat:${workspaceId}`;
  const newEvents = eventsAfterResume
    .filter((e) => e.channel === chatChannel)
    .map((e) => e.data as { type?: string });

  const hasNewError = newEvents.some((e) => e.type === "stream-error");
  if (hasNewError) {
    throw new Error("Resumed stream encountered an error");
  }
}

/**
 * Collect stream deltas until predicate returns true
 * Returns the accumulated buffer
 *
 * This function properly tracks consumed events to avoid returning duplicates
 */
async function collectStreamUntil(
  collector: ReturnType<typeof createEventCollector>,
  predicate: (buffer: string) => boolean,
  timeoutMs = 15000
): Promise<string> {
  const startTime = Date.now();
  let buffer = "";
  let lastProcessedIndex = -1;

  await collector.waitForEvent("stream-start", 5000);

  while (Date.now() - startTime < timeoutMs) {
    // Collect latest events
    collector.collect();
    const allDeltas = collector.getDeltas();

    // Process only new deltas (beyond lastProcessedIndex)
    const newDeltas = allDeltas.slice(lastProcessedIndex + 1);

    if (newDeltas.length > 0) {
      for (const delta of newDeltas) {
        const deltaData = delta as { delta?: string };
        if (deltaData.delta) {
          buffer += deltaData.delta;
        }
      }
      lastProcessedIndex = allDeltas.length - 1;

      // Log progress periodically
      if (allDeltas.length % 20 === 0) {
        console.log(
          `[collectStreamUntil] Processed ${allDeltas.length} deltas, buffer length: ${buffer.length}`
        );
      }

      // Check predicate after processing new deltas
      if (predicate(buffer)) {
        console.log(
          `[collectStreamUntil] Predicate satisfied after ${allDeltas.length} deltas, buffer length: ${buffer.length}`
        );
        return buffer;
      }
    }

    // Small delay before next poll
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  console.error(`[collectStreamUntil] Timeout after processing deltas, predicate never satisfied`);
  console.error(`[collectStreamUntil] Final buffer length: ${buffer.length}`);
  console.error(
    `[collectStreamUntil] Buffer sample (first 500 chars): ${buffer.substring(0, 500)}`
  );
  throw new Error("Timeout: predicate never satisfied");
}

describeIntegration("Stream Error Recovery (No Amnesia)", () => {
  test.concurrent(
    "should preserve exact prefix and continue from exact point after stream error",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace(PROVIDER);
      try {
        // Generate unique nonce for this test run
        const nonce = generateNonce();

        // Prompt model to produce structured, unambiguous output
        // Use a very explicit instruction with examples to maximize compliance
        const prompt = `I need you to count from 1 to 100 using a specific format. Output each number on its own line using EXACTLY this pattern:

${nonce}-1: one
${nonce}-2: two
${nonce}-3: three
${nonce}-4: four
${nonce}-5: five

Continue this pattern all the way to 100. Use only single-word number names (six, seven, eight, etc.).

IMPORTANT: Do not add any other text. Start immediately with ${nonce}-1: one. If interrupted, resume from where you stopped without repeating any lines.`;

        const sendResult = await sendMessageWithModel(
          env.mockIpcRenderer,
          workspaceId,
          prompt,
          modelString(PROVIDER, MODEL),
          { toolPolicy: [{ regex_match: ".*", action: "disable" }] }
        );
        expect(sendResult.success).toBe(true);

        // Collect stream deltas until we have at least STABLE_PREFIX_THRESHOLD complete markers
        const collector = createEventCollector(env.sentEvents, workspaceId);
        const preErrorBuffer = await collectStreamUntil(
          collector,
          (buf) => getMaxMarker(nonce, buf) >= STABLE_PREFIX_THRESHOLD,
          15000
        );

        // Build stable prefix (truncate to last complete marker)
        const stablePrefix = truncateToLastCompleteMarker(preErrorBuffer, nonce);
        const maxMarkerBeforeError = getMaxMarker(nonce, stablePrefix);

        console.log(`[Test] Nonce: ${nonce}, Max marker before error: ${maxMarkerBeforeError}`);
        console.log(`[Test] Stable prefix ends with: ${stablePrefix.slice(-200)}`);

        // Trigger error mid-stream
        await triggerStreamError(env.mockIpcRenderer, workspaceId, "Simulated network error");

        // Small delay to let error propagate
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Resume and wait for completion
        await resumeAndWaitForSuccess(
          env.mockIpcRenderer,
          workspaceId,
          env.sentEvents,
          `${PROVIDER}:${MODEL}`
        );

        // Read final assistant message from history
        const history = await readChatHistory(env.tempDir, workspaceId);
        const assistantMessages = history.filter((m) => m.role === "assistant");
        const finalText = assistantMessages
          .flatMap((m) => m.parts)
          .filter((p) => p.type === "text")
          .map((p) => (p as { text?: string }).text ?? "")
          .join("");

        // Normalize whitespace for comparison (trim trailing spaces/newlines)
        const normalizedPrefix = stablePrefix.trim();
        const normalizedFinal = finalText.trim();

        // ASSERTION 1: Prefix preservation - final text starts with exact pre-error prefix
        if (!normalizedFinal.startsWith(normalizedPrefix)) {
          console.error("[FAIL] Final text does NOT start with stable prefix");
          console.error("Expected prefix (last 300 chars):", normalizedPrefix.slice(-300));
          console.error("Actual start (first 300 chars):", normalizedFinal.substring(0, 300));
          console.error("Stable prefix length:", normalizedPrefix.length);
          console.error("Final text length:", normalizedFinal.length);
        }
        expect(normalizedFinal.startsWith(normalizedPrefix)).toBe(true);

        // ASSERTION 2: Exact continuation - search for next marker (k+1) shortly after prefix
        const nextMarker = `${nonce}-${maxMarkerBeforeError + 1}`;
        const searchWindow = normalizedFinal.substring(
          normalizedPrefix.length,
          normalizedPrefix.length + 2000
        );
        const foundNextMarker = searchWindow.includes(nextMarker);

        if (!foundNextMarker) {
          console.error("[FAIL] Next marker NOT found after prefix");
          console.error("Expected marker:", nextMarker);
          console.error("Search window (first 1200 chars):", searchWindow.substring(0, 1200));
          const allMarkers = extractMarkers(nonce, normalizedFinal);
          console.error("All markers found (first 30):", allMarkers.slice(0, 30));
        }
        expect(foundNextMarker).toBe(true);

        console.log("[Test] ✅ Prefix preserved and exact continuation verified");
      } finally {
        await cleanup();
      }
    },
    40000
  );
});
