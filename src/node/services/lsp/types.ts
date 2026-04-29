import type { LspProvisioningMode } from "@/common/config/schemas/appConfigOnDisk";
import type { Runtime } from "@/node/runtime/Runtime";

export type LspQueryOperation =
  | "hover"
  | "definition"
  | "references"
  | "implementation"
  | "document_symbols"
  | "workspace_symbols";

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspLocationLink {
  targetUri: string;
  targetRange: LspRange;
}

export interface LspMarkupContent {
  kind: "plaintext" | "markdown";
  value: string;
}

export interface LspMarkedString {
  language: string;
  value: string;
}

export interface LspHover {
  contents:
    | string
    | LspMarkupContent
    | LspMarkedString
    | Array<string | LspMarkupContent | LspMarkedString>;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: 1 | 2 | 3 | 4;
  code?: string | number;
  source?: string;
  message: string;
}

export interface LspPublishDiagnosticsParams {
  uri: string;
  version?: number;
  diagnostics: LspDiagnostic[];
  rawDiagnosticCount: number;
}

export interface LspFileDiagnostics {
  uri: string;
  path: string;
  serverId: string;
  rootUri: string;
  version?: number;
  diagnostics: LspDiagnostic[];
  receivedAtMs: number;
}

export interface LspDocumentSymbol {
  name: string;
  kind: number;
  detail?: string;
  range: LspRange;
  selectionRange: LspRange;
  uri?: string;
  children?: LspDocumentSymbol[];
}

export interface LspSymbolInformation {
  name: string;
  kind: number;
  detail?: string;
  location?: LspLocation | { uri: string };
  containerName?: string;
}

export interface LspSymbolExportInfo {
  isExported: boolean;
  confidence: "heuristic";
  evidence?: string;
}

export interface LspSymbolResult {
  name: string;
  kind: number;
  kindLabel: string;
  detail?: string;
  containerName?: string;
  path: string;
  uri: string;
  range: LspRange;
  preview?: string;
  exportInfo?: LspSymbolExportInfo;
}

export interface LspLocationResult {
  path: string;
  uri: string;
  range: LspRange;
  preview?: string;
}

export interface LspManagerSingleQueryResult {
  operation: LspQueryOperation;
  serverId: string;
  rootUri: string;
  hover?: string;
  locations?: LspLocationResult[];
  symbols?: LspSymbolResult[];
  warning?: string;
}

export type LspWorkspaceSymbolsSkipReasonCode =
  | "missing_binary"
  | "unsupported_provisioning"
  | "query_failed";

export interface LspWorkspaceSymbolsSkippedRoot {
  serverId: string;
  rootUri: string;
  reasonCode: LspWorkspaceSymbolsSkipReasonCode;
  reason: string;
  installGuidance?: string;
}

export interface LspManagerWorkspaceSymbolsResult {
  serverId: string;
  rootUri: string;
  symbols: LspSymbolResult[];
  warning?: string;
}

export interface LspManagerDirectoryWorkspaceSymbolsQueryResult {
  operation: "workspace_symbols";
  results: LspManagerWorkspaceSymbolsResult[];
  skippedRoots?: LspWorkspaceSymbolsSkippedRoot[];
  disambiguationHint?: string;
  warning?: string;
}

export type LspManagerQueryResult =
  | LspManagerSingleQueryResult
  | LspManagerDirectoryWorkspaceSymbolsQueryResult;

export interface LspPolicyContext {
  provisioningMode: LspProvisioningMode;
  trustedWorkspaceExecution: boolean;
}

export interface LspManualLaunchPolicy {
  type: "manual";
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  cwd?: string;
  initializationOptions?: unknown;
}

export type LspNodePackageManager = "bunx" | "pnpm" | "npm";

export interface LspWorkspaceLocalExecutableStrategy {
  type: "workspaceLocalExecutable";
  relativeCandidates: readonly string[];
}

export interface LspPathCommandStrategy {
  type: "pathCommand";
  command: string;
}

export interface LspNodePackageExecStrategy {
  type: "nodePackageExec";
  packageName: string;
  binaryName: string;
  packageManagers?: readonly LspNodePackageManager[];
  fallbackPackageNames?: readonly string[];
}

export interface LspGoManagedInstallStrategy {
  type: "goManagedInstall";
  module: string;
  binaryName: string;
  installSubdirectory?: readonly string[];
}

export interface LspUnsupportedProvisioningStrategy {
  type: "unsupported";
  message: string;
}

export type LspProvisioningStrategy =
  | LspWorkspaceLocalExecutableStrategy
  | LspPathCommandStrategy
  | LspNodePackageExecStrategy
  | LspGoManagedInstallStrategy
  | LspUnsupportedProvisioningStrategy;

export interface LspProvisionedLaunchPolicy {
  type: "provisioned";
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  cwd?: string;
  initializationOptions?: unknown;
  workspaceTsserverPathCandidates?: readonly string[];
  strategies: readonly LspProvisioningStrategy[];
}

export type LspServerLaunchPolicy = LspManualLaunchPolicy | LspProvisionedLaunchPolicy;

export interface ResolvedLspLaunchPlan {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  initializationOptions?: unknown;
}

export interface LspServerDescriptor {
  id: string;
  extensions: readonly string[];
  launch: LspServerLaunchPolicy;
  rootMarkers: readonly string[];
  languageIdForPath(filePath: string): string;
}

export interface LspClientFileHandle {
  runtimePath: string;
  readablePath: string;
  uri: string;
  languageId: string;
}

export interface LspClientQueryRequest {
  operation: LspQueryOperation;
  file?: LspClientFileHandle;
  line?: number;
  character?: number;
  query?: string;
  includeDeclaration?: boolean;
}

export interface LspClientQueryResult {
  operation: LspQueryOperation;
  hover?: string;
  locations?: LspLocation[];
  symbols?: Array<LspDocumentSymbol | LspSymbolInformation>;
}

export interface LspClientInstance {
  readonly isClosed: boolean;
  ensureFile(file: LspClientFileHandle): Promise<number>;
  closeTrackedFile?(uri: string): Promise<void>;
  getTrackedFiles?(): readonly LspClientFileHandle[];
  query(request: LspClientQueryRequest): Promise<LspClientQueryResult>;
  close(): Promise<void>;
}

export interface CreateLspClientOptions {
  descriptor: LspServerDescriptor;
  launchPlan: ResolvedLspLaunchPlan;
  runtime: Runtime;
  rootPath: string;
  rootUri: string;
  onPublishDiagnostics?: (params: LspPublishDiagnosticsParams) => void;
}
