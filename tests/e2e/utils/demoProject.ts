import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { Config } from "../../../src/node/config";

export interface DemoProjectConfig {
  projectPath: string;
  workspacePath: string;
  workspaceId: string;
  configPath: string;
  historyPath: string;
  sessionsDir: string;
}

export interface DemoProjectOptions {
  projectName?: string;
  workspaceBranch?: string;
  historyLines?: string[];
}

const DEFAULT_PROJECT_NAME = "demo-repo";
const DEFAULT_WORKSPACE_BRANCH = "demo-review";

function assertHistoryLines(lines: unknown): asserts lines is string[] | undefined {
  if (lines === undefined) {
    return;
  }
  if (!Array.isArray(lines) || lines.some((line) => typeof line !== "string")) {
    throw new Error("historyLines must be an array of strings when provided");
  }
}

export function prepareDemoProject(
  rootDir: string,
  options: DemoProjectOptions = {}
): DemoProjectConfig {
  const projectName = options.projectName?.trim() || DEFAULT_PROJECT_NAME;
  const workspaceBranch = options.workspaceBranch?.trim() || DEFAULT_WORKSPACE_BRANCH;
  assertHistoryLines(options.historyLines);

  const srcDir = path.join(rootDir, "src", projectName);
  const workspacePath = path.join(srcDir, workspaceBranch);
  const projectPath = path.join(rootDir, "fixtures", projectName);
  const configPath = path.join(rootDir, "config.json");
  const sessionsDir = path.join(rootDir, "sessions");

  // Ensure directories exist
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });

  // Initialize git repos with an initial commit so git commands work properly.
  // Empty repos cause errors like "fatal: ref HEAD is not a symbolic ref" when
  // detecting the default branch.
  for (const repoPath of [projectPath, workspacePath]) {
    spawnSync("git", ["init", "-q"], { cwd: repoPath });
    // Avoid hanging when developers have global commit signing enabled.
    spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: repoPath });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: repoPath });
    spawnSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: repoPath });
  }

  // E2E tests use legacy workspace ID format to test backward compatibility.
  // Production code now uses generateStableId() for new workspaces.
  const config = new Config(rootDir);
  const workspaceId = config.generateLegacyId(projectPath, workspacePath);
  const metadata = {
    id: workspaceId,
    name: workspaceBranch,
    projectName,
    projectPath,
  };

  const configPayload = {
    projects: [[projectPath, { workspaces: [{ path: workspacePath }] }]],
  } as const;

  fs.writeFileSync(configPath, JSON.stringify(configPayload, null, 2));

  const workspaceSessionDir = path.join(sessionsDir, workspaceId);
  fs.mkdirSync(workspaceSessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceSessionDir, "metadata.json"),
    JSON.stringify(metadata, null, 2)
  );
  const historyPath = path.join(workspaceSessionDir, "chat.jsonl");
  if (options.historyLines && options.historyLines.length > 0) {
    const history = options.historyLines.join("\n");
    fs.writeFileSync(historyPath, history.endsWith("\n") ? history : `${history}\n`);
  } else if (!fs.existsSync(historyPath)) {
    fs.writeFileSync(historyPath, "");
  }

  return {
    projectPath,
    workspacePath,
    workspaceId,
    configPath,
    historyPath,
    sessionsDir,
  };
}
