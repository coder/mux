import { shellQuote } from "@/common/utils/shell";

const SHELL_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertShellEnvName(key: string): void {
  if (!SHELL_ENV_NAME_PATTERN.test(key)) {
    throw new Error(`Invalid shell environment variable name: ${key}`);
  }
}

export function buildShellExport(
  key: string,
  value: string,
  quoteValue: (value: string) => string = shellQuote
): string {
  assertShellEnvName(key);
  return `export ${key}=${quoteValue(value)}`;
}
