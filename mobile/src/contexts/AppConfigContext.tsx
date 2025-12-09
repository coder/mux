import type { JSX, ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import { assert } from "@/common/utils/assert";

const STORAGE_KEY_BASE_URL = "com.coder.mux.app-settings.baseUrl";
const STORAGE_KEY_AUTH_TOKEN = "com.coder.mux.app-settings.authToken";
const DEFAULT_BASE_URL = "http://localhost:3000";
const URL_SCHEME_REGEX = /^[a-z][a-z0-9+.-]*:\/\//i;

interface ExpoMuxExtra {
  baseUrl?: string;
  authToken?: string;
}

export interface AppConfigContextValue {
  baseUrl: string;
  authToken: string;
  resolvedBaseUrl: string;
  resolvedAuthToken?: string;
  loading: boolean;
  setBaseUrl: (value: string) => Promise<void>;
  setAuthToken: (value: string) => Promise<void>;
}

function readExpoMuxExtra(): ExpoMuxExtra {
  const extra = Constants.expoConfig?.extra;
  if (!extra || typeof extra !== "object") {
    return {};
  }
  const muxExtra = (extra as { mux?: unknown }).mux;
  if (!muxExtra || typeof muxExtra !== "object" || Array.isArray(muxExtra)) {
    return {};
  }
  const record = muxExtra as Record<string, unknown>;
  return {
    baseUrl: typeof record.baseUrl === "string" ? record.baseUrl : undefined,
    authToken: typeof record.authToken === "string" ? record.authToken : undefined,
  };
}

function ensureHasScheme(value: string): string {
  if (URL_SCHEME_REGEX.test(value)) {
    return value;
  }
  return `http://${value}`;
}

function tryResolveBaseUrl(raw: string | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) {
    return DEFAULT_BASE_URL;
  }
  try {
    const candidate = ensureHasScheme(trimmed);
    return new URL(candidate).toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function normalizeAuthToken(raw: string | undefined): string | undefined {
  const trimmed = (raw ?? "").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const AppConfigContext = createContext<AppConfigContextValue | null>(null);

export function AppConfigProvider({ children }: { children: ReactNode }): JSX.Element {
  const expoDefaults = useMemo(() => readExpoMuxExtra(), []);
  const [resolvedBaseUrl, setResolvedBaseUrl] = useState(
    () => tryResolveBaseUrl(expoDefaults.baseUrl ?? DEFAULT_BASE_URL) ?? DEFAULT_BASE_URL
  );
  const [baseUrlInput, setBaseUrlInput] = useState(() => expoDefaults.baseUrl ?? DEFAULT_BASE_URL);
  const [authTokenInput, setAuthTokenInput] = useState(() => expoDefaults.authToken ?? "");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function loadStoredValues() {
      try {
        const [storedBaseUrl, storedAuthToken] = await Promise.all([
          SecureStore.getItemAsync(STORAGE_KEY_BASE_URL),
          SecureStore.getItemAsync(STORAGE_KEY_AUTH_TOKEN),
        ]);
        if (!mounted) return;
        if (typeof storedBaseUrl === "string") {
          setBaseUrlInput(storedBaseUrl);
          setResolvedBaseUrl(tryResolveBaseUrl(storedBaseUrl) ?? DEFAULT_BASE_URL);
        }
        if (typeof storedAuthToken === "string") {
          setAuthTokenInput(storedAuthToken);
        }
      } catch (error) {
        console.error("Failed to load persisted app settings", error);
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }
    void loadStoredValues();
    return () => {
      mounted = false;
    };
  }, []);

  const persistBaseUrl = useCallback(async (value: string): Promise<void> => {
    setBaseUrlInput(value);
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      setResolvedBaseUrl(DEFAULT_BASE_URL);
      try {
        await SecureStore.deleteItemAsync(STORAGE_KEY_BASE_URL);
      } catch (error) {
        console.error("Failed to clear base URL", error);
      }
      return;
    }

    const normalized = tryResolveBaseUrl(value);
    if (!normalized) {
      // Keep the previous resolved URL until the user finishes entering a valid value
      return;
    }

    setResolvedBaseUrl(normalized);
    try {
      await SecureStore.setItemAsync(STORAGE_KEY_BASE_URL, normalized);
    } catch (error) {
      console.error("Failed to persist base URL", error);
    }
  }, []);

  const persistAuthToken = useCallback(async (value: string): Promise<void> => {
    setAuthTokenInput(value);
    const trimmed = value.trim();
    try {
      if (trimmed.length > 0) {
        await SecureStore.setItemAsync(STORAGE_KEY_AUTH_TOKEN, trimmed);
      } else {
        await SecureStore.deleteItemAsync(STORAGE_KEY_AUTH_TOKEN);
      }
    } catch (error) {
      console.error("Failed to persist auth token", error);
    }
  }, []);

  const resolvedAuthToken = useMemo(() => normalizeAuthToken(authTokenInput), [authTokenInput]);

  const value = useMemo<AppConfigContextValue>(
    () => ({
      baseUrl: baseUrlInput,
      authToken: authTokenInput,
      resolvedBaseUrl,
      resolvedAuthToken,
      loading,
      setBaseUrl: persistBaseUrl,
      setAuthToken: persistAuthToken,
    }),
    [
      authTokenInput,
      baseUrlInput,
      loading,
      persistAuthToken,
      persistBaseUrl,
      resolvedAuthToken,
      resolvedBaseUrl,
    ]
  );

  return <AppConfigContext.Provider value={value}>{children}</AppConfigContext.Provider>;
}

export function useAppConfig(): AppConfigContextValue {
  const context = useContext(AppConfigContext);
  assert(context, "useAppConfig must be used within AppConfigProvider");
  return context;
}
