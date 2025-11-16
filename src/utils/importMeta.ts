export type ImportMetaEnv = Record<string, unknown> & {
  DEV?: boolean;
  [key: string]: unknown;
};

/**
 * Safely access Vite's import.meta.env without breaking Jest/Node environments.
 * Falls back to an empty object when import.meta is unavailable.
 */
export function getImportMetaEnv<T extends ImportMetaEnv = ImportMetaEnv>(): T {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
    const meta = new Function("return import.meta")() as { env?: T };
    return (meta?.env ?? {}) as T;
  } catch {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return {} as T;
  }
}
