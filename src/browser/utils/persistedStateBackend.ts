export interface PersistedStateBackend<T> {
  read?: (key: string) => T | undefined;
  write?: (key: string, value: T, previousValue?: T) => Promise<{ success: boolean }>;
  subscribe?: (key: string, callback: (value: T) => void) => () => void;
}

export interface LocalFirstBackendOptions<T> {
  isEqual?: (left: T, right: T) => boolean;
}

export interface LocalFirstBackend<T> extends PersistedStateBackend<T> {
  shouldApplyRemote: (key: string, value: T) => boolean;
  clearPending: (key: string) => void;
}

export function createLocalFirstBackend<T>(
  transport: PersistedStateBackend<T>,
  options?: LocalFirstBackendOptions<T>
): LocalFirstBackend<T> {
  const pendingByKey = new Map<string, T>();
  const isEqual = options?.isEqual ?? Object.is;

  const clearPending = (key: string) => {
    pendingByKey.delete(key);
  };

  const shouldApplyRemote = (key: string, value: T): boolean => {
    const pending = pendingByKey.get(key);
    if (!pending) {
      return true;
    }

    if (isEqual(pending, value)) {
      pendingByKey.delete(key);
      return true;
    }

    return false;
  };

  const write: PersistedStateBackend<T>["write"] = async (
    key: string,
    value: T,
    previousValue?: T
  ) => {
    pendingByKey.set(key, value);

    if (!transport.write) {
      return { success: true };
    }

    try {
      const result = await transport.write(key, value, previousValue);
      if (!result.success) {
        pendingByKey.delete(key);
      }
      return result;
    } catch {
      pendingByKey.delete(key);
      return { success: false };
    }
  };

  const subscribe: PersistedStateBackend<T>["subscribe"] = transport.subscribe
    ? (key, callback) =>
        transport.subscribe!(key, (value) => {
          if (shouldApplyRemote(key, value)) {
            callback(value);
          }
        })
    : undefined;

  return {
    read: transport.read,
    write,
    subscribe,
    shouldApplyRemote,
    clearPending,
  };
}
