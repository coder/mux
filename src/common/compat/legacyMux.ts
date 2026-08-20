import { SHUX_HOME_DIR_NAME, SHUX_PROTOCOL_SCHEME } from "@/common/constants/product";
import { type ShuxEnvironment } from "./shuxEnv";

export { assignShuxEnvironmentValue, resolveShuxEnvironmentValue } from "./shuxEnv";
export type { ShuxEnvironment } from "./shuxEnv";

/**
 * Compatibility contracts retained while the product transitions from mux to shux.
 *
 * Keep old names centralized here so canonical code can use shux terminology without
 * scattering one-off fallbacks. These aliases must remain until downgrade support is
 * intentionally removed in a future compatibility-breaking release.
 */
export const LEGACY_MUX_PRODUCT_SLUG = "mux";
export const LEGACY_MUX_PRODUCT_NAME = "Mux";
export const LEGACY_MUX_HOME_DIR_NAME = ".mux";
export const LEGACY_CMUX_HOME_DIR_NAME = ".cmux";
export const LEGACY_REMOTE_MUX_HOME = "~/.mux";
export const LEGACY_MUX_PROTOCOL_SCHEME = "mux";

/**
 * Sibling marker next to `~/.shux` / `~/.shux-dev`. Contents are a single known
 * leftover directory name (never an arbitrary path) so independent processes can
 * follow a default-home fallback without running the mutating transition.
 */
export const SHUX_HOME_LEGACY_FALLBACK_MARKER_SUFFIX = ".legacy-fallback";

export function getShuxHomeLegacyFallbackMarkerPath(homeDir: string, suffix = ""): string {
  // Keep this renderer/webview-safe: the VS Code browser bundle imports this module
  // for protocol aliases and cannot resolve node:path.
  return `${homeDir}/${SHUX_HOME_DIR_NAME}${suffix}${SHUX_HOME_LEGACY_FALLBACK_MARKER_SUFFIX}`;
}

export function listShuxHomeLegacyFallbackDirNames(suffix = ""): readonly string[] {
  const names = [LEGACY_MUX_HOME_DIR_NAME + suffix];
  if (!suffix) {
    names.push(LEGACY_CMUX_HOME_DIR_NAME);
  }
  return names;
}

/** Accept only a known leftover home name for this suffix. Reject paths and other tokens. */
export function parseShuxHomeLegacyFallbackDirName(
  contents: string,
  suffix = ""
): string | undefined {
  const token = contents.trim();
  return listShuxHomeLegacyFallbackDirNames(suffix).find((name) => name === token);
}

/**
 * Local product-home directory names, canonical first then legacy aliases.
 * Remote SSH `~/.mux`, Docker `/var/mux`, and project-local `.mux/` are separate contracts.
 */
export const LOCAL_PRODUCT_HOME_DIR_NAMES = [
  SHUX_HOME_DIR_NAME,
  LEGACY_MUX_HOME_DIR_NAME,
  LEGACY_CMUX_HOME_DIR_NAME,
] as const satisfies readonly [
  typeof SHUX_HOME_DIR_NAME,
  typeof LEGACY_MUX_HOME_DIR_NAME,
  typeof LEGACY_CMUX_HOME_DIR_NAME,
];

function tildePrefixesForHomeDirName(dirName: string): readonly [string, string] {
  return [`~/${dirName}`, `~\\${dirName}`];
}

/** Tilde prefixes that should expand through the active local home (`getShuxHome` / `*_ROOT`). */
export const LOCAL_PRODUCT_HOME_TILDE_PREFIXES = LOCAL_PRODUCT_HOME_DIR_NAMES.flatMap(
  tildePrefixesForHomeDirName
);

/**
 * If `filePath` is a recognized local product-home tilde path, return the suffix after that
 * home (empty string when the path is exactly the home). Windows-style `~\.shux` forms are
 * accepted so older configs stay portable. Unrelated `~` paths return undefined.
 */
export function getLocalProductHomeTildeSuffix(filePath: string): string | undefined {
  for (const prefix of LOCAL_PRODUCT_HOME_TILDE_PREFIXES) {
    if (!filePath.startsWith(prefix)) {
      continue;
    }

    const nextChar = filePath.at(prefix.length);
    if (nextChar !== undefined && nextChar !== "/" && nextChar !== "\\") {
      continue;
    }

    return filePath.slice(prefix.length).replace(/^[/\\]+/, "");
  }

  return undefined;
}

export const SUPPORTED_SHUX_PROTOCOL_SCHEMES = [
  SHUX_PROTOCOL_SCHEME,
  LEGACY_MUX_PROTOCOL_SCHEME,
] as const;

const LEGACY_MUX_BUILT_IN_SKILL_ALIASES = {
  "mux-docs": "shux-docs",
  "mux-diagram": "shux-diagram",
} as const satisfies Record<string, string>;

export function resolveLegacyMuxBuiltInSkillName(name: string): string {
  return (
    LEGACY_MUX_BUILT_IN_SKILL_ALIASES[name as keyof typeof LEGACY_MUX_BUILT_IN_SKILL_ALIASES] ??
    name
  );
}

const SHUX_ENV_PREFIX = "SHUX_";
const LEGACY_MUX_ENV_PREFIX = "MUX_";
const LEGACY_CMUX_MULTIPLE_INSTANCES = "CMUX_ALLOW_MULTIPLE_INSTANCES";

/**
 * Return an environment containing canonical SHUX_* names and downgrade-compatible
 * MUX_* aliases. When both are present, the canonical value wins deterministically.
 */
export function withLegacyMuxEnvironmentAliases<T extends ShuxEnvironment>(
  env: T
): T & ShuxEnvironment {
  const result: ShuxEnvironment = { ...env };

  for (const [key, value] of Object.entries(env)) {
    if (value == null || !key.startsWith(LEGACY_MUX_ENV_PREFIX)) {
      continue;
    }

    const canonicalKey = SHUX_ENV_PREFIX + key.slice(LEGACY_MUX_ENV_PREFIX.length);
    result[canonicalKey] ??= value;
  }

  for (const [key, value] of Object.entries(result)) {
    if (value == null || !key.startsWith(SHUX_ENV_PREFIX)) {
      continue;
    }

    const legacyKey = LEGACY_MUX_ENV_PREFIX + key.slice(SHUX_ENV_PREFIX.length);
    result[legacyKey] = value;
  }

  const allowMultipleInstances =
    result.SHUX_ALLOW_MULTIPLE_INSTANCES ??
    result.MUX_ALLOW_MULTIPLE_INSTANCES ??
    result[LEGACY_CMUX_MULTIPLE_INSTANCES];
  if (allowMultipleInstances != null) {
    result.SHUX_ALLOW_MULTIPLE_INSTANCES = allowMultipleInstances;
    result.MUX_ALLOW_MULTIPLE_INSTANCES = allowMultipleInstances;
    result[LEGACY_CMUX_MULTIPLE_INSTANCES] = allowMultipleInstances;
  }

  return result as T & ShuxEnvironment;
}

/** Apply the same aliases in place at a process boundary before other startup code reads env. */
export function installLegacyMuxEnvironmentAliases(env: ShuxEnvironment): void {
  Object.assign(env, withLegacyMuxEnvironmentAliases(env));
}
