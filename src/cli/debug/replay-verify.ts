import { defaultConfig } from "@/node/config";
import { HistoryService } from "@/node/services/historyService";
import { replayVerifySession } from "@/node/services/replay/replayVerify";

/**
 * Debug command: rebuild every turn's provider request from durable session
 * logs (chat.jsonl + turn-envelope rows + blob store) and byte-compare it
 * against the recorded request in devtools.jsonl (requires llmDebugLogs).
 *
 * Guarantee scope: same log + same config + same binary.
 * Usage: bun debug replay-verify <workspace-id>
 */
export async function replayVerifyCommand(workspaceId: string): Promise<void> {
  const sessionDir = defaultConfig.getSessionDir(workspaceId);
  const historyService = new HistoryService(defaultConfig);
  const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
  if (!historyResult.success) {
    console.error(`Failed to read chat history: ${historyResult.error}`);
    process.exitCode = 1;
    return;
  }

  const result = await replayVerifySession({
    sessionDir,
    workspaceId,
    historyMessages: historyResult.data,
  });

  console.log(`\n=== Replay verification for workspace: ${workspaceId} ===\n`);
  for (const note of result.notes) {
    console.log(`note: ${note}\n`);
  }
  if (result.turns.length === 0) {
    console.log(
      "No verifiable turns found. Replay verification needs turn-envelope rows " +
        "(durable-events.jsonl) AND recorded requests (devtools.jsonl via llmDebugLogs)."
    );
    return;
  }

  let failures = 0;
  for (const turn of result.turns) {
    const label = `turn ${turn.turnIndex} (envelope seq ${turn.envelopeSeq}, run ${turn.runId || "n/a"})`;
    if (turn.status === "SKIPPED") {
      console.log(`SKIP  ${label}: ${turn.reason ?? ""}`);
      continue;
    }
    if (turn.status === "PASS") {
      console.log(`PASS  ${label}`);
      continue;
    }
    failures++;
    console.log(`FAIL  ${label}`);
    if (turn.reason) {
      console.log(`      reason: ${turn.reason}`);
    }
    if (turn.systemPromptMatch === false) {
      console.log("      system prompt: recorded request differs from envelope blob");
    }
    if (turn.toolsetMatch === false) {
      console.log(`      toolset: ${turn.toolsetDiff ?? "manifest mismatch"}`);
    }
    if (turn.divergence) {
      console.log(`      first divergence at ${turn.divergence.path}`);
      console.log(`        rebuilt:  ${JSON.stringify(turn.divergence.expected)?.slice(0, 200)}`);
      console.log(`        recorded: ${JSON.stringify(turn.divergence.actual)?.slice(0, 200)}`);
    }
  }

  const passed = result.turns.filter((turn) => turn.status === "PASS").length;
  const skipped = result.turns.filter((turn) => turn.status === "SKIPPED").length;
  console.log(`\n${passed} PASS, ${failures} FAIL, ${skipped} SKIPPED\n`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}
