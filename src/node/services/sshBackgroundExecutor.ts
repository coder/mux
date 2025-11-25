/**
 * SSH background executor implementation (STUB).
 *
 * TODO: Implement using nohup/setsid + file-based output capture.
 *
 * Implementation approach:
 * 1. Spawn: ssh "mkdir -p /tmp/mux-bg/$ID && nohup setsid bash -c 'SCRIPT' > /tmp/mux-bg/$ID/out 2>&1 & echo $!"
 * 2. Read: ssh "tail -c +$OFFSET /tmp/mux-bg/$ID/out" (on-demand)
 * 3. Status: ssh "kill -0 $PID && echo running || cat /tmp/mux-bg/$ID/exitcode"
 * 4. Terminate: ssh "kill -TERM -$PID" then "kill -KILL -$PID"
 * 5. Cleanup: ssh "rm -rf /tmp/mux-bg/$ID"
 *
 * Exit code capture requires wrapper script:
 *   bash -c 'SCRIPT; echo $? > /tmp/mux-bg/$ID/exitcode'
 */

import type {
  BackgroundExecutor,
  BackgroundExecConfig,
  BackgroundSpawnResult,
} from "./backgroundExecutor";
import type { Runtime } from "@/node/runtime/Runtime";

/**
 * SSH background executor (not yet implemented)
 *
 * This executor will spawn background processes on remote SSH hosts
 * using nohup/setsid for detachment and file-based output capture.
 */
export class SSHBackgroundExecutor implements BackgroundExecutor {
  constructor(private readonly _runtime: Runtime) {
    // Runtime will be used for SSH commands when implemented
  }

  spawn(_script: string, _config: BackgroundExecConfig): Promise<BackgroundSpawnResult> {
    // TODO: Implement SSH background execution
    // See file header for implementation approach
    return Promise.resolve({
      success: false,
      error: "SSH background execution is not yet implemented",
    });
  }
}
