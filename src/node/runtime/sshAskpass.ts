import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import { log } from "@/node/services/log";

const ASKPASS_SCRIPT = `#!/bin/sh
# mux-askpass — SSH_ASKPASS helper for Mux
# Called by OpenSSH with the prompt text as $1.
# Writes prompt to a regular file, blocks on response FIFO.
printf '%s' "$1" > "$MUX_ASKPASS_DIR/prompt"
read -r response < "$MUX_ASKPASS_DIR/response"
printf '%s\\n' "$response"
`;

let askpassPath: string | undefined;

async function ensureAskpassScript(): Promise<string> {
  if (askpassPath) {
    try {
      await fs.promises.access(askpassPath, fs.constants.X_OK);
      return askpassPath;
    } catch {
      // Recreate the helper script if it was deleted.
    }
  }

  const dir = path.join(os.homedir(), ".mux", "bin");
  await fs.promises.mkdir(dir, { recursive: true });
  askpassPath = path.join(dir, "mux-askpass");
  await fs.promises.writeFile(askpassPath, ASKPASS_SCRIPT, { mode: 0o755 });
  return askpassPath;
}

/** Parse host/keyType/fingerprint from OpenSSH output. */
export function parseHostKeyPrompt(text: string): {
  host: string;
  keyType: string;
  fingerprint: string;
  prompt: string;
} {
  const hostMatch = /authenticity of host '([^']+)'/.exec(text);
  const keyMatch = /(\w+) key fingerprint is (SHA256:\S+)/.exec(text);
  return {
    host: hostMatch?.[1] ?? "unknown",
    keyType: keyMatch?.[1] ?? "unknown",
    fingerprint: keyMatch?.[2] ?? "unknown",
    prompt: text.trim(),
  };
}

export interface AskpassSession {
  /** Merge into the spawn env: { ...process.env, ...env } */
  env: Record<string, string>;
  /** Must be called when the SSH process exits. */
  cleanup(): void;
}

/**
 * Creates a per-probe askpass session.
 *
 * @param onPrompt Called when askpass fires. Receives the prompt text,
 *   must return the response string (e.g. "yes" or "no").
 */
export async function createAskpassSession(
  onPrompt: (prompt: string) => Promise<string>
): Promise<AskpassSession> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-askpass-"));
  const promptFile = path.join(dir, "prompt");
  const responseFifo = path.join(dir, "response");

  // Create the response FIFO — askpass blocks reading it
  execFileSync("mkfifo", [responseFifo]);

  let handled = false;

  // Watch for askpass to write the prompt file.
  // fs.watch is set up BEFORE SSH is spawned, so we cannot miss the event.
  const watcher = fs.watch(dir, (_, filename) => {
    // Some systems report filename as null — check directly
    if (handled || (filename !== null && filename !== "prompt")) return;

    void (async () => {
      try {
        await fs.promises.access(promptFile);
      } catch {
        return;
      }

      if (handled) return;
      handled = true;

      try {
        const promptText = await fs.promises.readFile(promptFile, "utf-8");
        const response = await onPrompt(promptText);
        // Writing to the FIFO unblocks the askpass script's `read`
        const fd = await fs.promises.open(responseFifo, "w");
        await fd.write(response + "\n");
        await fd.close();
      } catch (err) {
        log.debug("Askpass prompt handling failed:", err);
        // Write rejection to unblock askpass (best-effort)
        try {
          const fd = await fs.promises.open(responseFifo, "w");
          await fd.write("no\n");
          await fd.close();
        } catch {
          /* askpass may already be gone */
        }
      }
    })();
  });

  const scriptPath = await ensureAskpassScript();

  return {
    env: {
      SSH_ASKPASS: scriptPath,
      // Force askpass usage even with a controlling terminal (OpenSSH 8.4+)
      SSH_ASKPASS_REQUIRE: "force",
      // Enable askpass on pre-8.4 OpenSSH (DISPLAY must be non-empty)
      DISPLAY: process.env.DISPLAY ?? "mux",
      MUX_ASKPASS_DIR: dir,
    },
    cleanup() {
      handled = true;
      watcher.close();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}
