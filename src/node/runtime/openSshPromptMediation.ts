import { log } from "@/node/services/log";
import type { SshPromptResolutionReason, SshPromptService } from "@/node/services/sshPromptService";
import { createAskpassSession, parseHostKeyPrompt, type AskpassSession } from "./sshAskpass";

export interface MediatedAskpassOptions {
  sshPromptService: SshPromptService;
  /** Which prompt kinds to allow. Others return "" to fail fast. */
  promptPolicy: {
    allowHostKey: boolean;
    allowCredential: boolean;
  };
  /** Identity key for host-key deduplication (e.g., formatSshEndpoint(host, port)). */
  dedupeKey?: string;
  /**
   * Provides extra stderr context accumulated before the prompt arrived.
   * Used to extract host/keyType/fingerprint from OpenSSH output preceding the askpass prompt.
   */
  getStderrContext?: () => string;
  /** Called when a host-key prompt is detected (e.g., to extend a deadline timer). */
  onHostKeyPromptStarted?: () => void;
}

export interface MediatedPromptOutcome {
  kind: "host-key" | "credential";
  reason: SshPromptResolutionReason;
  response: string;
}

export interface MediatedAskpassSession extends AskpassSession {
  getLastPromptOutcome(): MediatedPromptOutcome | null;
}

export function classifyAskpassPrompt(promptText: string): "host-key" | "credential" {
  if (/continue connecting/i.test(promptText)) return "host-key";
  return "credential";
}

export async function createMediatedAskpassSession(
  options: MediatedAskpassOptions
): Promise<MediatedAskpassSession> {
  const { sshPromptService, promptPolicy, dedupeKey, getStderrContext, onHostKeyPromptStarted } =
    options;

  let lastPromptOutcome: MediatedPromptOutcome | null = null;

  const askpass = await createAskpassSession(async (promptText) => {
    const kind = classifyAskpassPrompt(promptText);

    if (kind === "host-key") {
      if (!promptPolicy.allowHostKey) {
        return "";
      }

      onHostKeyPromptStarted?.();

      const fullContext = `${getStderrContext?.() ?? ""}\n${promptText}`;
      const parsed = parseHostKeyPrompt(fullContext);
      const resolution = await sshPromptService.requestPromptDetailed({
        kind: "host-key",
        ...parsed,
        dedupeKey,
      });

      lastPromptOutcome = {
        kind: "host-key",
        reason: resolution.reason,
        response: resolution.response,
      };
      return resolution.response || "no";
    }

    if (!promptPolicy.allowCredential) {
      log.warn("SSH askpass: unsupported credential prompt, failing fast");
      return "";
    }

    const resolution = await sshPromptService.requestPromptDetailed({
      kind: "credential",
      prompt: promptText.trim(),
      secret: true,
    });

    lastPromptOutcome = {
      kind: "credential",
      reason: resolution.reason,
      response: resolution.response,
    };
    return resolution.response;
  });

  return {
    ...askpass,
    getLastPromptOutcome(): MediatedPromptOutcome | null {
      return lastPromptOutcome;
    },
  };
}
