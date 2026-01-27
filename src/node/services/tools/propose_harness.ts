import { tool } from "ai";
import { z } from "zod";
import * as jsonc from "jsonc-parser";

import { WorkspaceHarnessConfigSchema } from "@/common/orpc/schemas";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { RuntimeError } from "@/node/runtime/Runtime";
import { execBuffered, readFileString } from "@/node/utils/runtime/helpers";

const proposeHarnessSchema = z.object({});

const HARNESS_DIR = ".mux/harness";

function normalizeWorkspaceName(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function isAllowedHarnessGitPath(pathFromGit: string): boolean {
  return pathFromGit.startsWith(`${HARNESS_DIR}/`) && pathFromGit.endsWith(".jsonc");
}

function extractGitStatusPath(line: string): string | null {
  // Example porcelain lines:
  //  " M src/foo.ts"
  //  "?? .mux/harness/main.jsonc"
  //  "R  old -> new"
  if (typeof line !== "string" || line.length < 4) {
    return null;
  }

  const pathPart = line.slice(3).trim();
  if (!pathPart) {
    return null;
  }

  const arrowIndex = pathPart.indexOf(" -> ");
  if (arrowIndex >= 0) {
    return pathPart.slice(arrowIndex + 4).trim();
  }

  return pathPart;
}

export const createProposeHarnessTool: ToolFactory = (config) => {
  return tool({
    description: TOOL_DEFINITIONS.propose_harness.description,
    inputSchema: proposeHarnessSchema,
    execute: async () => {
      const workspaceName = normalizeWorkspaceName(config.muxEnv?.MUX_WORKSPACE_NAME);
      if (!workspaceName) {
        return {
          success: false as const,
          error: "No workspace name available (missing MUX_WORKSPACE_NAME).",
        };
      }

      const prefix = workspaceName;
      const harnessPath = config.runtime.normalizePath(
        `${HARNESS_DIR}/${prefix}.jsonc`,
        config.cwd
      );

      let harnessContent: string;
      try {
        harnessContent = await readFileString(config.runtime, harnessPath);
      } catch (err) {
        if (err instanceof RuntimeError) {
          return {
            success: false as const,
            error: `No harness file found at ${harnessPath}. Please write your harness to this file before calling propose_harness.`,
          };
        }
        throw err;
      }

      if (harnessContent === "") {
        return {
          success: false as const,
          error: `Harness file at ${harnessPath} is empty. Please write your harness content before calling propose_harness.`,
        };
      }

      const parseErrors: jsonc.ParseError[] = [];
      const parsed = jsonc.parse(harnessContent, parseErrors) as unknown;
      if (parseErrors.length > 0) {
        return {
          success: false as const,
          error: `Harness file at ${harnessPath} is not valid JSONC.`,
        };
      }

      const validated = WorkspaceHarnessConfigSchema.safeParse(parsed);
      if (!validated.success) {
        return {
          success: false as const,
          error: `Harness file at ${harnessPath} does not match the expected schema: ${validated.error.message}`,
        };
      }

      // Defensive: ensure harness-init didn't accidentally mutate other repo files (e.g. via bash).
      try {
        const isGitRepo = await execBuffered(
          config.runtime,
          "git rev-parse --is-inside-work-tree",
          {
            cwd: config.cwd,
            timeout: 10,
          }
        );
        if (isGitRepo.exitCode === 0 && isGitRepo.stdout.trim() === "true") {
          const status = await execBuffered(config.runtime, "git status --porcelain", {
            cwd: config.cwd,
            timeout: 10,
          });
          if (status.exitCode === 0) {
            const dirtyPaths = status.stdout
              .split(/\r?\n/)
              .map((line) => extractGitStatusPath(line))
              .filter((p): p is string => Boolean(p));
            const nonHarness = dirtyPaths.filter((p) => !isAllowedHarnessGitPath(p));
            if (nonHarness.length > 0) {
              return {
                success: false as const,
                error:
                  `Working tree has changes outside ${HARNESS_DIR}/*.jsonc: ` +
                  nonHarness.slice(0, 10).join(", "),
              };
            }
          }
        }
      } catch {
        // Best-effort only.
      }

      // Record file state for external edit detection
      if (config.recordFileState) {
        try {
          const fileStat = await config.runtime.stat(harnessPath);
          config.recordFileState(harnessPath, {
            content: harnessContent,
            timestamp: fileStat.modifiedTime.getTime(),
          });
        } catch {
          // File stat failed, skip recording
        }
      }

      return {
        success: true as const,
        harnessPath,
        message: "Harness proposed. Waiting for user approval.",
      };
    },
  });
};
