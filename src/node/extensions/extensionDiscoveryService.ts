import { constants as fsConstants, type Dirent } from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";

import {
  validateStaticManifest,
  type ExtensionDiagnostic,
  type RootKind,
  type ValidatedContribution,
  type ValidatedManifest,
} from "@/common/extensions/manifestValidator";
import type { ApprovalRecord } from "@/common/extensions/globalExtensionState";
import { hashRequestedPermissions } from "@/common/extensions/permissionCalculator";
import { ensureExtensionPathContained } from "@/node/extensions/extensionPathContainment";
import { ExtensionNameSchema } from "@/common/orpc/schemas/extension";
import {
  discoverExtensionRegistrations,
  type ExtensionActivationSession,
} from "@/node/extensions/extensionRegistrationDiscoveryService";
import {
  extractStaticManifestFromSource,
  type StaticManifestExtractionResult,
} from "@/node/extensions/staticManifestExtractor";
import { validateFileSize } from "@/node/services/tools/fileCommon";
import { parseSkillMarkdown } from "@/node/services/agentSkills/parseSkillMarkdown";
import { realpathOpenedFile } from "@/node/utils/openedFileRealpath";
import { SkillNameSchema } from "@/common/orpc/schemas/agentSkill";
import { hasErrorCode } from "@/node/services/tools/skillFileUtils";

export const PER_ROOT_TIMEOUT_MS_DEFAULT = 10_000;
export const PER_FILE_TIMEOUT_MS_DEFAULT = 5_000;

export type RootDiscoveryState = "pending" | "running" | "ready" | "failed";

export interface ExtensionRootDescriptor {
  /** Stable id used by the IPC layer; for project-local roots embeds the project path. */
  rootId: string;
  kind: RootKind;
  /** Absolute filesystem path to the Extension Root. */
  path: string;
  /** Bundled-only: marks Core Extensions whose contributions cannot be shadowed. */
  isCore?: boolean;
  /** Project-local-only: trust gate. Bundled and user-global roots are treated as trusted. */
  trusted?: boolean;
}

export interface DiscoveryStateLookupContext {
  rootId: string;
  rootKind: RootKind;
  extensionId: string;
  isBundled: boolean;
}

export interface DiscoveryStateLookup {
  /**
   * Returns whether the Extension is enabled. Discovery defaults to bundled=true,
   * non-bundled=false when no lookup is supplied.
   */
  isEnabled?: (ctx: DiscoveryStateLookupContext) => boolean;
  /**
   * Returns the persisted approval record for an Extension, if any. Discovery
   * uses presence-of-record as a precondition for Activation Discovery; the
   * capability calculator is the source of truth for effective capabilities.
   */
  getApprovalRecord?: (ctx: DiscoveryStateLookupContext) => ApprovalRecord | undefined;
}

export interface DiscoveredContribution {
  type: string;
  id: string;
  index: number;
  /** Extension Module-relative path for body-bearing types (skills, agents). */
  bodyPath?: string;
  /** Contained, symlink-checked absolute path validated during Activation Discovery. */
  bodyRealPath?: string;
  /**
   * True iff Activation Discovery validated this contribution's referenced
   * declarative file (or the type has no referenced files). For pre-activation
   * Extensions (untrusted root, disabled, ungranted), this is `false`.
   */
  activated: boolean;
}

export interface DiscoveredExtension {
  extensionId: string;
  rootId: string;
  rootKind: RootKind;
  isCore: boolean;
  /** Absolute filesystem path of the Extension Module on disk. */
  modulePath: string;
  manifest: ValidatedManifest;
  contributions: DiscoveredContribution[];
  diagnostics: ExtensionDiagnostic[];
  enabled: boolean;
  /**
   * True when a persisted approval record exists. Effective capability gating
   * is the capability calculator's job; Discovery Service only signals whether
   * Activation was eligible to run.
   */
  granted: boolean;
  /**
   * True iff every body-bearing contribution validated its file on disk.
   * Implies `enabled && granted && rootTrusted`.
   */
  activated: boolean;
}

export interface RootDiscoveryResult {
  rootId: string;
  kind: RootKind;
  path: string;
  trusted: boolean;
  /** False when the root directory does not exist on disk. */
  rootExists: boolean;
  state: RootDiscoveryState;
  extensions: DiscoveredExtension[];
  diagnostics: ExtensionDiagnostic[];
}

export interface ExtensionSnapshot {
  generatedAt: number;
  roots: RootDiscoveryResult[];
}

export interface ActivationSessionSinkRecord {
  rootId: string;
  extensionId: string;
  session: ExtensionActivationSession;
}

export type ActivationSessionSink = (record: ActivationSessionSinkRecord) => void;

export interface DiscoverExtensionsInput {
  roots: readonly ExtensionRootDescriptor[];
  state?: DiscoveryStateLookup;
  perRootTimeoutMs?: number;
  perFileTimeoutMs?: number;
  /** Receives successful Full Activation sandboxes for registry-owned disposal. */
  activationSessionSink?: ActivationSessionSink;
  /** Override `Date.now()` for deterministic diagnostics. */
  now?: number;
}

const TIMEOUT_SENTINEL = Symbol("discovery.timeout");

function isContainedRealPath(rootRealPath: string, candidateRealPath: string): boolean {
  const relativePath = path.relative(rootRealPath, candidateRealPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsPromises.stat(p);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return false;
    throw error;
  }
}

async function withTimeout<T>(
  createPromise: () => Promise<T>,
  timeoutMs: number
): Promise<T | typeof TIMEOUT_SENTINEL> {
  // 0 (or negative) is the degenerate-but-useful "always time out" mode used
  // by tests; do not even start the work or it can keep touching cleaned-up
  // fixture roots after the caller has already received a timeout result.
  if (timeoutMs <= 0) return TIMEOUT_SENTINEL;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<T | typeof TIMEOUT_SENTINEL>([
      createPromise(),
      new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function discoverExtensions(
  input: DiscoverExtensionsInput
): Promise<ExtensionSnapshot> {
  const now = input.now ?? Date.now();
  const perRootTimeoutMs = input.perRootTimeoutMs ?? PER_ROOT_TIMEOUT_MS_DEFAULT;
  const perFileTimeoutMs = input.perFileTimeoutMs ?? PER_FILE_TIMEOUT_MS_DEFAULT;

  const roots = await Promise.all(
    input.roots.map((root) =>
      discoverRoot(root, {
        activationSessionSink: input.activationSessionSink,
        state: input.state,
        now,
        perRootTimeoutMs,
        perFileTimeoutMs,
      })
    )
  );

  return { generatedAt: now, roots };
}

interface RootContext {
  state?: DiscoveryStateLookup;
  activationSessionSink?: ActivationSessionSink;
  now: number;
  perRootTimeoutMs: number;
  perFileTimeoutMs: number;
}

async function discoverRoot(
  root: ExtensionRootDescriptor,
  ctx: RootContext
): Promise<RootDiscoveryResult> {
  const trusted = root.kind === "project-local" ? root.trusted === true : true;
  const result = (overrides: Partial<RootDiscoveryResult>): RootDiscoveryResult => ({
    rootId: root.rootId,
    kind: root.kind,
    path: root.path,
    trusted,
    rootExists: true,
    state: "ready",
    extensions: [],
    diagnostics: [],
    ...overrides,
  });

  // Phase 1: Existence detection. Cheap; runs unconditionally.
  let rootPathExists: boolean;
  try {
    rootPathExists = await pathExists(root.path);
  } catch (error) {
    return result({
      state: "failed",
      diagnostics: [
        {
          code: "root.access.failed",
          severity: "error",
          message: `Failed to access Extension Root ${root.path}: ${(error as Error).message ?? String(error)}`,
          occurredAt: ctx.now,
        },
      ],
    });
  }
  if (!rootPathExists) {
    return result({ rootExists: false });
  }

  // Pre-trust gate: project-local existence detection only. Discovery must NOT
  // read package.json from an untrusted project-local root.
  if (root.kind === "project-local" && !trusted) {
    return result({});
  }

  let rootTimedOut = false;
  const rootCtx: RootContext = ctx.activationSessionSink
    ? {
        ...ctx,
        activationSessionSink: (record) => {
          if (rootTimedOut) {
            record.session.dispose();
            return;
          }
          ctx.activationSessionSink?.(record);
        },
      }
    : ctx;
  const raceResult = await withTimeout(
    () => discoverRootInner(root, rootCtx, result),
    ctx.perRootTimeoutMs
  );

  if (raceResult === TIMEOUT_SENTINEL) {
    rootTimedOut = true;
    return result({
      state: "failed",
      diagnostics: [
        {
          code: "root.discovery.timeout",
          severity: "error",
          message: `Extension Root discovery exceeded the ${ctx.perRootTimeoutMs}ms timeout (${root.kind} ${root.path}).`,
          occurredAt: ctx.now,
        },
      ],
    });
  }

  return raceResult;
}

async function discoverRootInner(
  root: ExtensionRootDescriptor,
  ctx: RootContext,
  result: (overrides: Partial<RootDiscoveryResult>) => RootDiscoveryResult
): Promise<RootDiscoveryResult> {
  const moduleDiscovery = await discoverExtensionModules(root, ctx);
  if (moduleDiscovery !== null) {
    return result({
      state: moduleDiscovery.failed ? "failed" : "ready",
      extensions: moduleDiscovery.extensions,
      diagnostics: moduleDiscovery.diagnostics,
    });
  }

  // Extension Modules v1 intentionally ignores package.json/npm roots. A root
  // contributes only direct child folders that contain extension.ts.
  return result({});
}

interface ModuleDiscoveryResult {
  extensions: DiscoveredExtension[];
  diagnostics: ExtensionDiagnostic[];
  failed: boolean;
}

async function discoverExtensionModules(
  root: ExtensionRootDescriptor,
  ctx: RootContext
): Promise<ModuleDiscoveryResult | null> {
  if (root.kind === "project-local" && root.trusted !== true) {
    return { failed: false, extensions: [], diagnostics: [] };
  }

  let entries: Dirent[];
  try {
    entries = await fsPromises.readdir(root.path, { withFileTypes: true });
  } catch (error) {
    return {
      failed: true,
      extensions: [],
      diagnostics: [
        {
          code: "root.read.failed",
          severity: "error",
          message: `Failed to list Extension Root ${root.path}: ${(error as Error).message ?? String(error)}`,
          occurredAt: ctx.now,
        },
      ],
    };
  }

  let rootRealPath: string;
  try {
    rootRealPath = await fsPromises.realpath(root.path);
  } catch (error) {
    return {
      failed: true,
      extensions: [],
      diagnostics: [
        {
          code: "root.read.failed",
          severity: "error",
          message: `Failed to resolve Extension Root ${root.path}: ${error instanceof Error ? error.message : String(error)}`,
          occurredAt: ctx.now,
        },
      ],
    };
  }
  const diagnostics: ExtensionDiagnostic[] = [];
  const extensions: DiscoveredExtension[] = [];
  let sawEntrypoint = false;

  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const modulePath = path.join(root.path, entry.name);
    let moduleRealPath: string;
    let moduleStat;
    try {
      moduleRealPath = await fsPromises.realpath(modulePath);
      if (!isContainedRealPath(rootRealPath, moduleRealPath)) {
        diagnostics.push({
          code: "extension.module.outside_root",
          severity: "error",
          message: `Extension Module folder ${JSON.stringify(entry.name)} resolves outside the Extension Root.`,
          extensionId: entry.name,
          occurredAt: ctx.now,
        });
        continue;
      }
      moduleStat = await fsPromises.stat(moduleRealPath);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) continue;
      diagnostics.push({
        code: "extension.module.read_failed",
        severity: "error",
        message: `Failed to inspect Extension Module folder ${JSON.stringify(entry.name)}: ${error instanceof Error ? error.message : String(error)}`,
        extensionId: entry.name,
        occurredAt: ctx.now,
      });
      continue;
    }
    if (!moduleStat.isDirectory()) continue;

    const entrypointPath = path.join(moduleRealPath, "extension.ts");
    let hasEntrypoint: boolean;
    try {
      hasEntrypoint = await pathExists(entrypointPath);
    } catch (error) {
      diagnostics.push({
        code: "extension.entrypoint.read_failed",
        severity: "error",
        message: `Failed to access extension.ts for ${JSON.stringify(entry.name)}: ${error instanceof Error ? error.message : String(error)}`,
        extensionId: entry.name,
        occurredAt: ctx.now,
      });
      continue;
    }
    if (!hasEntrypoint) continue;
    sawEntrypoint = true;

    if (!ExtensionNameSchema.safeParse(entry.name).success) {
      diagnostics.push({
        code: "extension.name.invalid",
        severity: "error",
        message: `Extension Module folder name ${JSON.stringify(
          entry.name
        )} must be kebab-case and match the Extension Name rules.`,
        extensionId: entry.name,
        occurredAt: ctx.now,
      });
      continue;
    }

    const candidate = await discoverCandidateExtensionModule(root, entry.name, moduleRealPath, ctx);
    diagnostics.push(...candidate.rootDiagnostics);
    if (candidate.extension) extensions.push(candidate.extension);
  }

  if (!sawEntrypoint && diagnostics.length === 0) return null;
  return { failed: false, extensions, diagnostics };
}

function staticManifestHasSkillsCapability(rawManifest: Record<string, unknown>): boolean {
  const capabilities = rawManifest.capabilities;
  return isPlainObject(capabilities) && capabilities.skills === true;
}

function normalizeRegistrationBodyPath(bodyPath: string): string {
  return path.posix.normalize(bodyPath.replace(/\\/gu, "/"));
}

function registrationKey(contribution: ValidatedContribution): string {
  const body =
    typeof contribution.descriptor.body === "string"
      ? normalizeRegistrationBodyPath(contribution.descriptor.body)
      : "";
  return `${contribution.type}\0${contribution.id}\0${body}`;
}

function isExecutionConsoleDiagnostic(diagnostic: ExtensionDiagnostic): boolean {
  return (
    diagnostic.code === "extension.discovery.console" ||
    diagnostic.code === "extension.activation.console"
  );
}

function activationUndiscoveredDiagnostics(
  extensionId: string,
  discovered: readonly ValidatedContribution[],
  activated: readonly ValidatedContribution[],
  now: number
): ExtensionDiagnostic[] {
  const discoveredKeys = new Set(discovered.map(registrationKey));
  return activated
    .filter((contribution) => !discoveredKeys.has(registrationKey(contribution)))
    .map((contribution) => ({
      code: "extension.activation.undiscovered",
      severity: "error" as const,
      message: `Full Activation registered ${contribution.type}/${contribution.id}, which was not observed during Registration Discovery.`,
      extensionId,
      contributionRef: {
        type: contribution.type,
        index: contribution.index,
        id: contribution.id,
      },
      occurredAt: now,
    }));
}

function approvalCoversRequestedPermissions(
  approval: ApprovalRecord | undefined,
  requestedPermissions: readonly string[]
): boolean {
  if (!approval) return false;
  if (approval.requestedPermissionsHash !== hashRequestedPermissions(requestedPermissions))
    return false;
  const granted = new Set(approval.grantedPermissions);
  return Array.from(new Set(requestedPermissions)).every((permission) => granted.has(permission));
}

async function extractContainedStaticManifest(input: {
  modulePath: string;
  entrypointPath: string;
  extensionName: string;
  now: number;
}): Promise<StaticManifestExtractionResult> {
  let moduleRealPath: string;
  let entrypointRealPath: string;
  try {
    [moduleRealPath, entrypointRealPath] = await Promise.all([
      fsPromises.realpath(input.modulePath),
      fsPromises.realpath(input.entrypointPath),
    ]);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "extension.entrypoint.read_failed",
          severity: "error",
          message: `Failed to access extension.ts: ${error instanceof Error ? error.message : String(error)}`,
          extensionId: input.extensionName,
          occurredAt: input.now,
        },
      ],
    };
  }

  if (!isContainedRealPath(moduleRealPath, entrypointRealPath)) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "extension.entrypoint.invalid",
          severity: "error",
          message: "extension.ts resolves outside the Extension Module.",
          extensionId: input.extensionName,
          occurredAt: input.now,
        },
      ],
    };
  }

  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle: Awaited<ReturnType<typeof fsPromises.open>>;
  try {
    handle = await fsPromises.open(entrypointRealPath, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "extension.entrypoint.read_failed",
          severity: "error",
          message: `Failed to read extension.ts: ${error instanceof Error ? error.message : String(error)}`,
          extensionId: input.extensionName,
          occurredAt: input.now,
        },
      ],
    };
  }

  try {
    const openedRealPath = await realpathOpenedFile(handle, entrypointRealPath);
    if (
      path.normalize(openedRealPath) !== path.normalize(entrypointRealPath) ||
      !isContainedRealPath(moduleRealPath, openedRealPath)
    ) {
      return {
        ok: false,
        diagnostics: [
          {
            code: "extension.entrypoint.invalid",
            severity: "error",
            message: "Opened extension.ts resolves outside its validated path.",
            extensionId: input.extensionName,
            occurredAt: input.now,
          },
        ],
      };
    }

    const stat = await handle.stat();
    if (!stat.isFile()) {
      return {
        ok: false,
        diagnostics: [
          {
            code: "extension.entrypoint.invalid",
            severity: "error",
            message: "extension.ts must be a regular file.",
            extensionId: input.extensionName,
            occurredAt: input.now,
          },
        ],
      };
    }

    const sizeValidation = validateFileSize({
      size: stat.size,
      modifiedTime: stat.mtime,
      isDirectory: false,
    });
    if (sizeValidation) {
      return {
        ok: false,
        diagnostics: [
          {
            code: "extension.entrypoint.read_failed",
            severity: "error",
            message: `Failed to read extension.ts: ${sizeValidation.error}`,
            extensionId: input.extensionName,
            occurredAt: input.now,
          },
        ],
      };
    }

    return extractStaticManifestFromSource(
      await handle.readFile("utf-8"),
      entrypointRealPath,
      input.now
    );
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "extension.entrypoint.read_failed",
          severity: "error",
          message: `Failed to read extension.ts: ${error instanceof Error ? error.message : String(error)}`,
          extensionId: input.extensionName,
          occurredAt: input.now,
        },
      ],
    };
  } finally {
    await handle.close();
  }
}

async function discoverCandidateExtensionModule(
  root: ExtensionRootDescriptor,
  extensionName: string,
  modulePath: string,
  ctx: RootContext
): Promise<CandidateResult> {
  const entrypointPath = path.join(modulePath, "extension.ts");
  const extraction = await extractContainedStaticManifest({
    modulePath,
    entrypointPath,
    extensionName,
    now: ctx.now,
  });
  if (!extraction.ok) {
    return {
      rootDiagnostics: extraction.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        extensionId: diagnostic.extensionId ?? extensionName,
      })),
    };
  }

  const validation = validateStaticManifest({
    rawManifest: extraction.manifest,
    extensionName,
    rootKind: root.kind,
    now: ctx.now,
  });
  if (!validation.ok) {
    return { rootDiagnostics: validation.diagnostics };
  }

  const registrationDiscovery = await discoverExtensionRegistrations({
    extensionName: validation.manifest.id,
    entrypointPath,
    allowSkills: staticManifestHasSkillsCapability(extraction.manifest),
    now: ctx.now,
    timeoutMs: ctx.perFileTimeoutMs,
  });
  const registrationRequestedPermissions =
    registrationDiscovery.contributions.length > 0 ? ["skill.register"] : [];
  const manifest: ValidatedManifest = {
    ...validation.manifest,
    requestedPermissions: Array.from(
      new Set([...validation.manifest.requestedPermissions, ...registrationRequestedPermissions])
    ),
    contributions: registrationDiscovery.contributions,
  };
  const contributions = manifest.contributions.map(toDiscoveredContribution);
  const isBundled = root.kind === "bundled";
  const stateCtx: DiscoveryStateLookupContext = {
    rootId: root.rootId,
    rootKind: root.kind,
    extensionId: manifest.id,
    isBundled,
  };
  const enabled = ctx.state?.isEnabled?.(stateCtx) ?? isBundled;
  const approvalRecord = ctx.state?.getApprovalRecord?.(stateCtx);
  const granted = isBundled || approvalRecord !== undefined;
  const approvedForCurrentPermissions =
    isBundled || approvalCoversRequestedPermissions(approvalRecord, manifest.requestedPermissions);
  // Full Activation validates registrations already observed during Registration
  // Discovery; it must not become a second discovery pass that can execute
  // mode-gated permission asks before the user approves them.
  const activationEligible =
    registrationDiscovery.contributions.length > 0 &&
    (root.kind === "bundled" || root.kind === "user-global" || root.trusted === true) &&
    enabled &&
    approvedForCurrentPermissions;

  const extensionDiagnostics: ExtensionDiagnostic[] = [
    ...validation.diagnostics,
    ...registrationDiscovery.diagnostics,
  ];
  let activated = false;
  if (activationEligible) {
    const activationDiscovery = await discoverExtensionRegistrations({
      extensionName: manifest.id,
      entrypointPath,
      allowSkills: staticManifestHasSkillsCapability(extraction.manifest),
      mode: "activate",
      now: ctx.now,
      timeoutMs: ctx.perFileTimeoutMs,
    });
    const activationSession = activationDiscovery.activationSession;
    let keepActivationSession = false;
    try {
      extensionDiagnostics.push(...activationDiscovery.diagnostics);
      const undiscoveredDiagnostics = activationUndiscoveredDiagnostics(
        manifest.id,
        manifest.contributions,
        activationDiscovery.contributions,
        ctx.now
      );
      extensionDiagnostics.push(...undiscoveredDiagnostics);

      const activationFailureDiagnostics = activationDiscovery.diagnostics.filter(
        (diagnostic) => !isExecutionConsoleDiagnostic(diagnostic)
      );
      if (activationFailureDiagnostics.length === 0 && undiscoveredDiagnostics.length === 0) {
        let allActivated = true;
        const activatedContributionKeys = new Set(
          activationDiscovery.contributions.map(registrationKey)
        );
        for (let i = 0; i < contributions.length; i++) {
          if (!activatedContributionKeys.has(registrationKey(manifest.contributions[i]))) continue;
          const activationResult = await activateContribution(
            manifest.id,
            modulePath,
            manifest.contributions[i],
            contributions[i],
            ctx
          );
          contributions[i] = activationResult.contribution;
          if (!activationResult.contribution.activated) allActivated = false;
          extensionDiagnostics.push(...activationResult.diagnostics);
        }
        activated = allActivated;
      }
      if (activated && activationSession && ctx.activationSessionSink) {
        ctx.activationSessionSink({
          rootId: root.rootId,
          extensionId: manifest.id,
          session: activationSession,
        });
        keepActivationSession = true;
      }
    } finally {
      if (!keepActivationSession) activationSession?.dispose();
    }
  }

  return {
    rootDiagnostics: [],
    extension: {
      extensionId: manifest.id,
      rootId: root.rootId,
      rootKind: root.kind,
      isCore: root.isCore === true,
      modulePath,
      manifest,
      contributions,
      diagnostics: extensionDiagnostics,
      enabled,
      granted,
      activated,
    },
  };
}

interface CandidateResult {
  extension?: DiscoveredExtension;
  /** Root-level diagnostics for malformed Extension Modules. */
  rootDiagnostics: ExtensionDiagnostic[];
}

function toDiscoveredContribution(c: ValidatedContribution): DiscoveredContribution {
  const bodyPath = needsBodyFile(c.type)
    ? typeof c.descriptor.body === "string"
      ? c.descriptor.body
      : undefined
    : undefined;
  return {
    type: c.type,
    id: c.id,
    index: c.index,
    bodyPath,
    activated: false,
  };
}

function needsBodyFile(type: string): boolean {
  return type === "skills" || type === "agents";
}

async function readActivationBodyFile(realPath: string): Promise<{
  content: string | null;
  sizeValidationError?: string;
}> {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await fsPromises.open(realPath, fsConstants.O_RDONLY | noFollow);
  try {
    const openedRealPath = await realpathOpenedFile(handle, realPath);
    if (path.normalize(openedRealPath) !== path.normalize(realPath)) {
      throw new Error("Opened body file resolves outside its validated path.");
    }

    const stat = await handle.stat();
    const sizeValidation = validateFileSize({
      size: stat.size,
      modifiedTime: stat.mtime,
      isDirectory: stat.isDirectory(),
    });
    if (sizeValidation) {
      return { content: null, sizeValidationError: sizeValidation.error };
    }

    return { content: await handle.readFile("utf-8") };
  } finally {
    await handle.close();
  }
}

interface ActivationResult {
  contribution: DiscoveredContribution;
  diagnostics: ExtensionDiagnostic[];
}

async function activateContribution(
  extensionId: string,
  modulePath: string,
  validated: ValidatedContribution,
  contribution: DiscoveredContribution,
  ctx: RootContext
): Promise<ActivationResult> {
  const diagnostics: ExtensionDiagnostic[] = [];

  // Descriptor-only types validated at manifest time; nothing more to read.
  if (!needsBodyFile(contribution.type)) {
    return {
      contribution: { ...contribution, activated: true },
      diagnostics,
    };
  }

  const bodyPath = contribution.bodyPath;
  if (!bodyPath) {
    diagnostics.push({
      code: "contribution.body.missing",
      severity: "warn",
      message: `Contribution "${contribution.type}/${contribution.id}" is missing a body path.`,
      extensionId,
      contributionRef: { type: contribution.type, index: validated.index, id: contribution.id },
      occurredAt: ctx.now,
    });
    return { contribution, diagnostics };
  }

  // ensureExtensionPathContained rejects on invalid paths; race the timeout
  // and translate either failure into a contribution-level diagnostic so a
  // single bad body never derails Activation Discovery for siblings.
  const containResult = await withTimeout(
    () =>
      ensureExtensionPathContained(modulePath, bodyPath).then(
        (v) => ({ ok: true as const, value: v }),
        (err: unknown) => ({
          ok: false as const,
          error: err instanceof Error ? err : new Error(String(err)),
        })
      ),
    ctx.perFileTimeoutMs
  );
  if (containResult === TIMEOUT_SENTINEL) {
    diagnostics.push({
      code: "contribution.body.timeout",
      severity: "error",
      message: `Reading body for "${contribution.type}/${contribution.id}" exceeded the ${ctx.perFileTimeoutMs}ms timeout.`,
      extensionId,
      contributionRef: { type: contribution.type, index: validated.index, id: contribution.id },
      occurredAt: ctx.now,
    });
    return { contribution, diagnostics };
  }
  if (!containResult.ok) {
    diagnostics.push({
      code: "contribution.body.invalid",
      severity: "warn",
      message: `Body path for "${contribution.type}/${contribution.id}" is invalid: ${containResult.error.message}`,
      extensionId,
      contributionRef: { type: contribution.type, index: validated.index, id: contribution.id },
      occurredAt: ctx.now,
    });
    return { contribution, diagnostics };
  }

  const bodyResult = await withTimeout(
    () =>
      readActivationBodyFile(containResult.value.realPath).then(
        (v) => ({ ok: true as const, value: v }),
        (err: unknown) => ({
          ok: false as const,
          error: err instanceof Error ? err : new Error(String(err)),
        })
      ),
    ctx.perFileTimeoutMs
  );
  if (bodyResult === TIMEOUT_SENTINEL) {
    diagnostics.push({
      code: "contribution.body.timeout",
      severity: "error",
      message: `Reading body for "${contribution.type}/${contribution.id}" exceeded the ${ctx.perFileTimeoutMs}ms timeout.`,
      extensionId,
      contributionRef: { type: contribution.type, index: validated.index, id: contribution.id },
      occurredAt: ctx.now,
    });
    return { contribution, diagnostics };
  }
  if (!bodyResult.ok) {
    diagnostics.push({
      code: "contribution.body.invalid",
      severity: "warn",
      message: `Failed to read body for "${contribution.type}/${contribution.id}": ${bodyResult.error.message}`,
      extensionId,
      contributionRef: { type: contribution.type, index: validated.index, id: contribution.id },
      occurredAt: ctx.now,
    });
    return { contribution, diagnostics };
  }
  if (bodyResult.value.sizeValidationError) {
    diagnostics.push({
      code: "contribution.body.invalid",
      severity: "warn",
      message: `Body for "${contribution.type}/${contribution.id}" is invalid: ${bodyResult.value.sizeValidationError}`,
      extensionId,
      contributionRef: { type: contribution.type, index: validated.index, id: contribution.id },
      occurredAt: ctx.now,
    });
    return { contribution, diagnostics };
  }
  const bodyContent = bodyResult.value.content;
  if (bodyContent == null) {
    throw new Error("readActivationBodyFile returned no content without a validation error");
  }

  if (contribution.type === "skills") {
    const skillName = SkillNameSchema.safeParse(contribution.id);
    if (!skillName.success) {
      diagnostics.push({
        code: "contribution.body.invalid",
        severity: "warn",
        message: `Skill contribution name "${contribution.id}" is invalid: ${skillName.error.message}`,
        extensionId,
        contributionRef: { type: contribution.type, index: validated.index, id: contribution.id },
        occurredAt: ctx.now,
      });
      return { contribution, diagnostics };
    }
    try {
      parseSkillMarkdown({
        content: bodyContent,
        byteSize: Buffer.byteLength(bodyContent, "utf-8"),
        directoryName: skillName.data,
      });
    } catch (error) {
      diagnostics.push({
        code: "contribution.body.invalid",
        severity: "warn",
        message: `Body for "${contribution.type}/${contribution.id}" is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
        extensionId,
        contributionRef: { type: contribution.type, index: validated.index, id: contribution.id },
        occurredAt: ctx.now,
      });
      return { contribution, diagnostics };
    }
  }

  return {
    contribution: { ...contribution, bodyRealPath: containResult.value.realPath, activated: true },
    diagnostics,
  };
}
