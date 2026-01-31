/**
 * Stable host-surface for renderer extensions.
 *
 * For now, extensions are in-process and can import from the codebase directly.
 * HostApi exists so we can gradually introduce a narrow, compatibility-friendly API.
 */

export interface HostApiStorage {
  read: <T>(key: string, defaultValue: T) => T;
  update: <T>(key: string, value: T | ((prev: T) => T), defaultValue?: T) => void;
}

export interface HostApi {
  storage: HostApiStorage;
  reportError: (message: string, error: unknown) => void;
}
