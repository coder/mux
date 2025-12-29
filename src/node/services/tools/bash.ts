import { tool } from "ai";
// NOTE: We avoid readline; consume Web Streams directly to prevent race conditions
import * as path from "path";
import {
  BASH_DEFAULT_TIMEOUT_SECS,
  BASH_HARD_MAX_LINES,
  BASH_MAX_LINE_BYTES,
  BASH_MAX_TOTAL_BYTES,
  BASH_MAX_FILE_BYTES,
  BASH_TRUNCATE_MAX_TOTAL_BYTES,
  BASH_TRUNCATE_MAX_FILE_BYTES,
} from "@/common/constants/toolLimits";
import { EXIT_CODE_ABORTED, EXIT_CODE_TIMEOUT } from "@/common/constants/exitCodes";

import type { BashOutputEvent } from "@/common/types/stream";
import type { BashToolResult } from "@/common/types/tools";
import { resolveBashDisplayName } from "@/common/utils/tools/bashDisplayName";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { toBashTaskId } from "./taskId";
import { migrateToBackground } from "@/node/services/backgroundProcessExecutor";

/**
 * Validates bash script input for common issues
 * Returns error result if validation fails, null if valid
 */
function validateScript(script: string, config: ToolConfiguration): BashToolResult | null {
  // Check for empty script
  if (!script || script.trim().length === 0) {
    return {
      success: false,
      error: "Script parameter is empty. This likely indicates a malformed tool call.",
      exitCode: -1,
      wall_duration_ms: 0,
    };
  }

  // Block sleep at the beginning of commands - they waste time waiting
  if (/^\s*sleep\s/.test(script)) {
    return {
      success: false,
      error:
        "do not start commands with sleep; prefer <10s sleeps in busy loops (e.g., 'while ! condition; do sleep 1; done' or 'until condition; do sleep 1; done').",
      exitCode: -1,
      wall_duration_ms: 0,
    };
  }

  // Detect redundant cd to working directory
  const cdPattern = /^\s*cd\s+['"]?([^'";&|]+)['"]?\s*[;&|]/;
  const match = cdPattern.exec(script);
  if (match) {
    const targetPath = match[1].trim();
    const normalizedTarget = config.runtime.normalizePath(targetPath, config.cwd);
    const normalizedCwd = config.runtime.normalizePath(".", config.cwd);

    if (normalizedTarget === normalizedCwd) {
      return {
        success: false,
        error: `Redundant cd to working directory detected. The tool already runs in ${config.cwd} - no cd needed. Remove the 'cd ${targetPath}' prefix.`,
        exitCode: -1,
        wall_duration_ms: 0,
      };
    }
  }

  return null; // Valid
}

/**
 * Creates a line handler that enforces truncation limits
 * Processes lines for both stdout and stderr with identical logic
 */
function createLineHandler(
  lines: string[],
  totalBytesRef: { current: number },
  limits: {
    maxLineBytes: number;
    maxFileBytes: number;
    maxTotalBytes: number;
    maxLines: number;
  },
  state: {
    displayTruncated: boolean;
    fileTruncated: boolean;
  },
  triggerDisplayTruncation: (reason: string) => void,
  triggerFileTruncation: (reason: string) => void
): (line: string) => void {
  return (line: string) => {
    if (state.fileTruncated) return;

    const lineBytes = Buffer.byteLength(line, "utf-8");

    // Check if line exceeds per-line limit (hard stop - likely corrupt data)
    if (lineBytes > limits.maxLineBytes) {
      triggerFileTruncation(
        `Line ${lines.length + 1} exceeded per-line limit: ${lineBytes} bytes > ${limits.maxLineBytes} bytes`
      );
      return;
    }

    // Check file limit BEFORE adding line
    const bytesAfterLine = totalBytesRef.current + lineBytes + 1; // +1 for newline
    if (bytesAfterLine > limits.maxFileBytes) {
      triggerFileTruncation(
        `Total output would exceed file preservation limit: ${bytesAfterLine} bytes > ${limits.maxFileBytes} bytes (at line ${lines.length + 1})`
      );
      return;
    }

    // Collect line (even if display is truncated, keep for file)
    lines.push(line);
    totalBytesRef.current = bytesAfterLine;

    // Check display limits (soft stop - keep collecting for file)
    if (!state.displayTruncated) {
      if (totalBytesRef.current > limits.maxTotalBytes) {
        triggerDisplayTruncation(
          `Total output exceeded display limit: ${totalBytesRef.current} bytes > ${limits.maxTotalBytes} bytes (at line ${lines.length})`
        );
        return;
      }

      if (lines.length >= limits.maxLines) {
        triggerDisplayTruncation(
          `Line count exceeded display limit: ${lines.length} lines >= ${limits.maxLines} lines (${totalBytesRef.current} bytes read)`
        );
      }
    }
  };
}

/**
 * Formats the final bash tool result based on exit code and truncation state
 */
function formatResult(
  exitCode: number,
  lines: string[],
  truncated: boolean,
  overflowReason: string | null,
  wall_duration_ms: number,
  overflowPolicy: "tmpfile" | "truncate",
  effectiveTimeout: number
): BashToolResult {
  const output = lines.join("\n");

  // Check for special error codes from runtime
  if (exitCode === EXIT_CODE_ABORTED) {
    return {
      success: false,
      error: "Command execution was aborted",
      exitCode: -1,
      wall_duration_ms,
    };
  }

  if (exitCode === EXIT_CODE_TIMEOUT) {
    return {
      success: false,
      error: `Command exceeded timeout of ${effectiveTimeout} seconds. You can increase the timeout by setting the \`timeout_secs\` parameter on the tool call. Do not use the \`timeout\` bash command to increase the timeout.`,
      exitCode: -1,
      wall_duration_ms,
    };
  }

  // Handle truncation
  if (truncated) {
    const truncationInfo = {
      reason: overflowReason ?? "unknown reason",
      totalLines: lines.length,
    };

    if (overflowPolicy === "truncate") {
      // Return all collected lines with truncation marker
      if (exitCode === 0) {
        return {
          success: true,
          output,
          exitCode: 0,
          wall_duration_ms,
          truncated: truncationInfo,
        };
      } else {
        return {
          success: false,
          output,
          exitCode,
          error: `Command exited with code ${exitCode}`,
          wall_duration_ms,
          truncated: truncationInfo,
        };
      }
    }
  }

  // Normal exit
  if (exitCode === 0) {
    return {
      success: true,
      output,
      exitCode: 0,
      wall_duration_ms,
    };
  } else {
    return {
      success: false,
      output,
      exitCode,
      error: `Command exited with code ${exitCode}`,
      wall_duration_ms,
    };
  }
}

/**
 * Bash execution tool factory for AI assistant
 * Creates a bash tool that can execute commands with a configurable timeout
 * @param config Required configuration including working directory
 */
export const createBashTool: ToolFactory = (config: ToolConfiguration) => {
  // Select limits based on overflow policy
  // truncate = IPC calls (generous limits for UI features, no line limit, no per-line limit)
  // tmpfile = AI agent calls (conservative limits for LLM context)
  const overflowPolicy = config.overflow_policy ?? "tmpfile";
  const maxTotalBytes =
    overflowPolicy === "truncate" ? BASH_TRUNCATE_MAX_TOTAL_BYTES : BASH_MAX_TOTAL_BYTES;
  const maxFileBytes =
    overflowPolicy === "truncate" ? BASH_TRUNCATE_MAX_FILE_BYTES : BASH_MAX_FILE_BYTES;
  const maxLines = overflowPolicy === "truncate" ? Infinity : BASH_HARD_MAX_LINES;
  const maxLineBytes = overflowPolicy === "truncate" ? Infinity : BASH_MAX_LINE_BYTES;

  return tool({
    description: TOOL_DEFINITIONS.bash.description + "\nRuns in " + config.cwd + " - no cd needed",
    inputSchema: TOOL_DEFINITIONS.bash.schema,
    execute: async (
      { script, timeout_secs, run_in_background, display_name },
      { abortSignal, toolCallId }
    ): Promise<BashToolResult> => {
      // Validate script input

      // Treat display_name as untrusted input: it ends up in filesystem paths.
      const safeDisplayName = resolveBashDisplayName(script, display_name);
      const validationError = validateScript(script, config);
      if (validationError) return validationError;

      // Handle explicit background execution (run_in_background=true)
      if (run_in_background) {
        if (!config.workspaceId || !config.backgroundProcessManager || !config.runtime) {
          return {
            success: false,
            error:
              "Background execution is only available for AI tool calls, not direct IPC invocation",
            exitCode: -1,
            wall_duration_ms: 0,
          };
        }

        const startTime = performance.now();
        const spawnResult = await config.backgroundProcessManager.spawn(
          config.runtime,
          config.workspaceId,
          script,
          {
            cwd: config.cwd,
            // Match foreground bash behavior: muxEnv is present and secrets override it.
            env: { ...(config.muxEnv ?? {}), ...(config.secrets ?? {}) },
            displayName: safeDisplayName,
            isForeground: false, // Explicit background
            timeoutSecs: timeout_secs, // Auto-terminate after this duration
          }
        );

        if (!spawnResult.success) {
          return {
            success: false,
            error: spawnResult.error,
            exitCode: -1,
            wall_duration_ms: Math.round(performance.now() - startTime),
          };
        }

        return {
          success: true,
          output: `Background process started with ID: ${spawnResult.processId}`,
          exitCode: 0,
          wall_duration_ms: Math.round(performance.now() - startTime),
          taskId: toBashTaskId(spawnResult.processId),
          backgroundProcessId: spawnResult.processId,
        };
      }

      // Setup execution parameters
      const effectiveTimeout = timeout_secs ?? BASH_DEFAULT_TIMEOUT_SECS;
      const startTime = performance.now();
      const totalBytesRef = { current: 0 }; // Use ref for shared access in line handler
      let overflowReason: string | null = null;
      const truncationState = { displayTruncated: false, fileTruncated: false };

      // Track backgrounding state
      let backgrounded = false;
      let backgroundResolve: (() => void) | null = null;

      // Wrap abort signal so we can detach when migrating to background.
      // When detached, the original stream abort won't kill the process.
      const wrappedAbortController = new AbortController();
      let abortDetached = false;
      if (abortSignal) {
        abortSignal.addEventListener("abort", () => {
          if (!abortDetached) {
            wrappedAbortController.abort();
          }
        });
      }

      // Register foreground process for "send to background" feature
      // Only if manager is available (AI tool calls, not IPC)
      const fgRegistration =
        config.backgroundProcessManager && config.workspaceId && toolCallId
          ? config.backgroundProcessManager.registerForegroundProcess(
              config.workspaceId,
              toolCallId,
              script,
              safeDisplayName,
              () => {
                backgrounded = true;
                // Resolve the background promise to unblock the wait
                if (backgroundResolve) backgroundResolve();
              }
            )
          : null;

      // Execute using runtime interface (works for both local and SSH)
      const scriptWithClosedStdin = `exec </dev/null
${script}`;
      const execStream = await config.runtime.exec(scriptWithClosedStdin, {
        cwd: config.cwd,
        env: { ...config.muxEnv, ...config.secrets },
        timeout: effectiveTimeout,
        abortSignal: wrappedAbortController.signal,
      });

      // Force-close stdin immediately - we don't need to send any input
      // Use abort() instead of close() for immediate, synchronous closure
      // close() is async and waits for acknowledgment, which can hang over SSH
      // abort() immediately marks stream as errored and releases locks
      execStream.stdin.abort().catch(() => {
        /* ignore */ return;
      });

      // Tee streams so we can migrate to background if needed
      // One branch goes to line handler (UI), other is held for potential migration
      const [stdoutForUI, stdoutForMigration] = execStream.stdout.tee();
      const [stderrForUI, stderrForMigration] = execStream.stderr.tee();

      // Collect output concurrently from Web Streams to avoid readline race conditions.
      const lines: string[] = [];
      let truncated = false;

      // Helper to trigger display truncation (stop showing to agent, keep collecting)
      const triggerDisplayTruncation = (reason: string) => {
        truncationState.displayTruncated = true;
        truncated = true;
        overflowReason = reason;
        // Don't kill process yet - keep collecting up to file limit
      };

      // Helper to trigger file truncation (stop collecting, close streams)
      const triggerFileTruncation = (reason: string) => {
        truncationState.fileTruncated = true;
        truncationState.displayTruncated = true;
        truncated = true;
        overflowReason = reason;
        // Cancel all stream branches to stop the process and unblock readers
        stdoutForUI.cancel().catch(() => {
          /* ignore */ return;
        });
        stderrForUI.cancel().catch(() => {
          /* ignore */ return;
        });
        stdoutForMigration.cancel().catch(() => {
          /* ignore */ return;
        });
        stderrForMigration.cancel().catch(() => {
          /* ignore */ return;
        });
      };

      // Create unified line handler for both stdout and stderr
      const lineHandler = createLineHandler(
        lines,
        totalBytesRef,
        { maxLineBytes, maxFileBytes, maxTotalBytes, maxLines },
        truncationState,
        triggerDisplayTruncation,
        triggerFileTruncation
      );

      // UI-only incremental output streaming over workspace.onChat (not sent to the model).
      // We flush chunked text rather than per-line to keep overhead low.
      let liveOutputStopped = false;
      let liveStdoutBuffer = "";
      let liveStderrBuffer = "";
      let liveOutputTimer: ReturnType<typeof setInterval> | null = null;

      const LIVE_FLUSH_INTERVAL_MS = 75;
      const MAX_LIVE_EVENT_CHARS = 32_768;

      const emitBashOutput = (isError: boolean, text: string): void => {
        if (!config.emitChatEvent || !config.workspaceId || !toolCallId) return;
        if (liveOutputStopped) return;
        if (text.length === 0) return;

        config.emitChatEvent({
          type: "bash-output",
          workspaceId: config.workspaceId,
          toolCallId,
          text,
          isError,
          timestamp: Date.now(),
        } satisfies BashOutputEvent);
      };

      const flushLiveOutput = (): void => {
        if (liveOutputStopped) return;

        const flush = (isError: boolean, buffer: string): void => {
          if (buffer.length === 0) return;
          for (let i = 0; i < buffer.length; i += MAX_LIVE_EVENT_CHARS) {
            emitBashOutput(isError, buffer.slice(i, i + MAX_LIVE_EVENT_CHARS));
          }
        };

        if (liveStdoutBuffer.length > 0) {
          const buf = liveStdoutBuffer;
          liveStdoutBuffer = "";
          flush(false, buf);
        }

        if (liveStderrBuffer.length > 0) {
          const buf = liveStderrBuffer;
          liveStderrBuffer = "";
          flush(true, buf);
        }
      };

      const stopLiveOutput = (flush: boolean): void => {
        if (liveOutputStopped) return;
        if (flush) flushLiveOutput();

        liveOutputStopped = true;

        if (liveOutputTimer) {
          clearInterval(liveOutputTimer);
          liveOutputTimer = null;
        }

        liveStdoutBuffer = "";
        liveStderrBuffer = "";
      };

      if (config.emitChatEvent && config.workspaceId && toolCallId) {
        liveOutputTimer = setInterval(flushLiveOutput, LIVE_FLUSH_INTERVAL_MS);
      }

      const appendLiveOutput = (isError: boolean, text: string): void => {
        if (!config.emitChatEvent || !config.workspaceId || !toolCallId) return;
        if (liveOutputStopped) return;
        if (text.length === 0) return;

        if (isError) {
          liveStderrBuffer += text;
          if (liveStderrBuffer.length >= MAX_LIVE_EVENT_CHARS) flushLiveOutput();
        } else {
          liveStdoutBuffer += text;
          if (liveStdoutBuffer.length >= MAX_LIVE_EVENT_CHARS) flushLiveOutput();
        }
      };

      // Consume a ReadableStream<Uint8Array> and emit lines to lineHandler.
      // Uses TextDecoder streaming to preserve multibyte boundaries.
      const consumeStream = async (
        stream: ReadableStream<Uint8Array>,
        isError: boolean
      ): Promise<void> => {
        const reader = stream.getReader();
        const decoder = new TextDecoder("utf-8");
        let carry = "";

        // Set up abort handler to cancel reader when abort signal fires
        // This interrupts reader.read() if it's blocked, preventing hangs
        const abortHandler = () => {
          reader.cancel().catch(() => {
            /* ignore - reader may already be closed */
          });
        };
        abortSignal?.addEventListener("abort", abortHandler);

        try {
          while (true) {
            if (truncationState.fileTruncated) {
              // Stop early if we already hit hard limits
              await reader.cancel().catch(() => {
                /* ignore */ return;
              });
              break;
            }
            const { value, done } = await reader.read();
            if (done) break;
            // Decode chunk (streaming keeps partial code points)
            const text = decoder.decode(value, { stream: true });
            appendLiveOutput(isError, text);
            carry += text;

            // Split into lines; support both \n and \r\n
            let start = 0;
            while (true) {
              const idxN = carry.indexOf("\n", start);
              const idxR = carry.indexOf("\r", start);
              let nextIdx = -1;
              if (idxN === -1 && idxR === -1) break;
              nextIdx = idxN === -1 ? idxR : idxR === -1 ? idxN : Math.min(idxN, idxR);
              const line = carry.slice(0, nextIdx).replace(/\r$/, "");
              lineHandler(line);
              carry = carry.slice(nextIdx + 1);
              start = 0;
              if (truncationState.fileTruncated) {
                await reader.cancel().catch(() => {
                  /* ignore */ return;
                });
                break;
              }
            }

            // Defensive: if output never emits newlines, carry can grow without bound.
            // If the incomplete line already violates hard limits, stop early.
            if (carry.length > 0 && !truncationState.fileTruncated) {
              const carryBytes = Buffer.byteLength(carry, "utf-8");
              const bytesAfterCarry = totalBytesRef.current + carryBytes + 1; // +1 for newline
              if (carryBytes > maxLineBytes || bytesAfterCarry > maxFileBytes) {
                // Delegate to lineHandler to keep truncation reasons consistent.
                lineHandler(carry);
                if (truncationState.fileTruncated) {
                  await reader.cancel().catch(() => {
                    /* ignore */ return;
                  });
                  break;
                }
              }
            }
            if (truncationState.fileTruncated) break;
          }
        } finally {
          // Clean up abort listener
          abortSignal?.removeEventListener("abort", abortHandler);

          // Flush decoder for any trailing bytes and emit the last line (if any)
          try {
            const tail = decoder.decode();
            if (tail) {
              appendLiveOutput(isError, tail);
              carry += tail;
            }
            if (carry.length > 0 && !truncationState.fileTruncated) {
              lineHandler(carry);
            }
          } catch {
            // ignore decoder errors on flush
          }
        }
      };

      // Start consuming stdout and stderr concurrently (using UI branches)
      const consumeStdout = consumeStream(stdoutForUI, false);
      const consumeStderr = consumeStream(stderrForUI, true);

      // Create a promise that resolves when user clicks "Background"
      const backgroundPromise = new Promise<void>((resolve) => {
        backgroundResolve = resolve;
      });

      // Wait for process exit and stream consumption concurrently
      // Also race with the background promise to detect early return request
      const foregroundCompletion = Promise.all([execStream.exitCode, consumeStdout, consumeStderr]);

      let exitCode: number;
      try {
        const result = await Promise.race([
          foregroundCompletion,
          backgroundPromise.then(() => "backgrounded" as const),
        ]);

        // Check if we were backgrounded
        if (result === "backgrounded" || backgrounded) {
          // Detach from abort signal as early as possible - process should continue running
          // even when the stream ends and fires abort.
          abortDetached = true;

          // Unregister foreground process
          fgRegistration?.unregister();

          // Stop UI-only output streaming before migrating to background.
          stopLiveOutput(true);

          // Stop consuming UI stream branches - further output should be handled by bash_output.
          stdoutForUI.cancel().catch(() => {
            /* ignore */ return;
          });
          stderrForUI.cancel().catch(() => {
            /* ignore */ return;
          });

          // Avoid unhandled promise rejections if the cancelled UI readers cause
          // the foreground consumption promise to reject after we return.
          void foregroundCompletion.catch(() => undefined);

          const wall_duration_ms = Math.round(performance.now() - startTime);

          // Migrate to background tracking if manager is available
          if (config.backgroundProcessManager && config.workspaceId) {
            const processId =
              config.backgroundProcessManager.generateUniqueProcessId(safeDisplayName);

            // Create a synthetic ExecStream for the migration streams
            // The UI streams are still being consumed, migration streams continue to files
            const migrationStream = {
              stdout: stdoutForMigration,
              stderr: stderrForMigration,
              stdin: execStream.stdin,
              exitCode: execStream.exitCode,
              duration: execStream.duration,
            };

            const migrateResult = await migrateToBackground(
              migrationStream,
              {
                cwd: config.cwd,
                workspaceId: config.workspaceId,
                processId,
                script,
                existingOutput: lines,
              },
              config.backgroundProcessManager.getBgOutputDir()
            );

            if (migrateResult.success) {
              // Register the migrated process with the manager
              config.backgroundProcessManager.registerMigratedProcess(
                migrateResult.handle,
                processId,
                config.workspaceId,
                script,
                migrateResult.outputDir,
                safeDisplayName
              );

              return {
                success: true,
                output: `Process sent to background with ID: ${processId}\n\nOutput so far (${lines.length} lines):\n${lines.slice(-20).join("\n")}${lines.length > 20 ? "\n...(showing last 20 lines)" : ""}`,
                exitCode: 0,
                wall_duration_ms,
                taskId: toBashTaskId(processId),
                backgroundProcessId: processId,
              };
            }
            // Migration failed, fall through to simple return
          }

          // Fallback: return without process ID (no manager or migration failed)
          return {
            success: true,
            output: `Process sent to background. It will continue running.\n\nOutput so far (${lines.length} lines):\n${lines.slice(-20).join("\n")}${lines.length > 20 ? "\n...(showing last 20 lines)" : ""}`,
            exitCode: 0,
            wall_duration_ms,
          };
        }

        // Normal completion - extract exit code
        exitCode = result[0];
      } catch (err: unknown) {
        // Unregister on error
        fgRegistration?.unregister();

        // Check if this was an abort
        if (abortSignal?.aborted) {
          return {
            success: false,
            error: "Command execution was aborted",
            exitCode: -1,
            wall_duration_ms: Math.round(performance.now() - startTime),
          };
        }
        return {
          success: false,
          error: `Failed to execute command: ${err instanceof Error ? err.message : String(err)}`,
          exitCode: -1,
          wall_duration_ms: Math.round(performance.now() - startTime),
        };
      } finally {
        stopLiveOutput(true);
      }

      // Unregister foreground process on normal completion
      fgRegistration?.unregister();

      // Check if command was aborted (exitCode will be EXIT_CODE_ABORTED = -997)
      // This can happen if abort signal fired after Promise.all resolved but before we check
      if (abortSignal?.aborted) {
        return {
          success: false,
          error: "Command execution was aborted",
          exitCode: -1,
          wall_duration_ms: Math.round(performance.now() - startTime),
        };
      }

      // Round to integer to preserve tokens
      const wall_duration_ms = Math.round(performance.now() - startTime);

      // Handle tmpfile overflow policy separately (writes to file)
      if (truncated && (config.overflow_policy ?? "tmpfile") === "tmpfile") {
        // tmpfile policy: Save overflow output to temp file instead of returning an error
        // We don't show ANY of the actual output to avoid overwhelming context.
        // Instead, save it to a temp file and encourage the agent to use filtering tools.
        try {
          // Use 8 hex characters for short, memorable temp file IDs
          const fileId = Math.random().toString(16).substring(2, 10);
          // Write to runtime temp directory (managed by StreamManager)
          // Use path.posix.join to preserve forward slashes for SSH runtime
          // (config.runtimeTempDir is always a POSIX path like /home/user/.mux-tmp/token)
          const overflowPath = path.posix.join(config.runtimeTempDir, `bash-${fileId}.txt`);
          const fullOutput = lines.join("\n");

          // Use runtime.writeFile() for SSH support
          const writer = config.runtime.writeFile(overflowPath, abortSignal);
          const encoder = new TextEncoder();
          const writerInstance = writer.getWriter();
          await writerInstance.write(encoder.encode(fullOutput));
          await writerInstance.close();

          const output = `[OUTPUT OVERFLOW - ${overflowReason ?? "unknown reason"}]

Full output (${lines.length} lines) saved to ${overflowPath}

Use selective filtering tools (e.g. grep) to extract relevant information and continue your task

File will be automatically cleaned up when stream ends.`;

          return {
            success: false,
            error: output,
            exitCode: -1,
            wall_duration_ms,
          };
        } catch (err) {
          // If temp file creation fails, fall back to original error
          return {
            success: false,
            error: `Command output overflow: ${overflowReason ?? "unknown reason"}. Failed to save overflow to temp file: ${String(err)}`,
            exitCode: -1,
            wall_duration_ms,
          };
        }
      }

      // Format result based on exit code and truncation state
      return formatResult(
        exitCode,
        lines,
        truncated,
        overflowReason,
        wall_duration_ms,
        config.overflow_policy ?? "tmpfile",
        effectiveTimeout
      );
    },
  });
};
