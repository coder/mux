import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "@/browser/contexts/RouterContext";

interface OpenSettingsOptions {
  /** When opening the Providers settings, expand the given provider. */
  expandProvider?: string;
  /** When opening the Runtimes settings, pre-select this project scope. */
  runtimesProjectPath?: string;
  /** Stable project identifier for Runtimes scope pre-selection. */
  runtimesProjectId?: string;
  /** When opening the Secrets settings, pre-select this project scope. */
  secretsProjectPath?: string;
  /** Stable project identifier for Secrets scope pre-selection. */
  secretsProjectId?: string;
}

interface SettingsContextValue {
  isOpen: boolean;
  activeSection: string;
  open: (section?: string, options?: OpenSettingsOptions) => void;
  close: () => void;
  setActiveSection: (section: string) => void;

  /** Subscribe to settings close events. Returns an unsubscribe function. */
  registerOnClose: (callback: () => void) => () => void;

  /** One-shot hint for ProvidersSection to expand a provider. */
  providersExpandedProvider: string | null;
  setProvidersExpandedProvider: (provider: string | null) => void;

  /** One-shot hint for RuntimesSection to pre-select a project scope. */
  runtimesProjectPath: string | null;
  setRuntimesProjectPath: (path: string | null) => void;
  runtimesProjectId: string | null;
  setRuntimesProjectId: (projectId: string | null) => void;

  /** One-shot hint for SecretsSection to pre-select a project scope. */
  secretsProjectPath: string | null;
  setSecretsProjectPath: (path: string | null) => void;
  secretsProjectId: string | null;
  setSecretsProjectId: (projectId: string | null) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}

const DEFAULT_SECTION = "general";

export function SettingsProvider(props: { children: ReactNode }) {
  const router = useRouter();
  const [providersExpandedProvider, setProvidersExpandedProvider] = useState<string | null>(null);
  const [runtimesProjectPath, setRuntimesProjectPath] = useState<string | null>(null);
  const [runtimesProjectId, setRuntimesProjectId] = useState<string | null>(null);
  const [secretsProjectPath, setSecretsProjectPath] = useState<string | null>(null);
  const [secretsProjectId, setSecretsProjectId] = useState<string | null>(null);

  const closeCallbacksRef = useRef(new Set<() => void>());

  const isOpen = router.currentSettingsSection != null;
  const activeSection = router.currentSettingsSection ?? DEFAULT_SECTION;

  const open = useCallback(
    (section?: string, options?: OpenSettingsOptions) => {
      const nextSection = section ?? DEFAULT_SECTION;
      if (nextSection === "providers") {
        setProvidersExpandedProvider(options?.expandProvider ?? null);
      } else {
        setProvidersExpandedProvider(null);
      }
      if (nextSection === "runtimes") {
        setRuntimesProjectPath(options?.runtimesProjectPath ?? null);
        setRuntimesProjectId(options?.runtimesProjectId ?? null);
      } else {
        setRuntimesProjectPath(null);
        setRuntimesProjectId(null);
      }
      if (nextSection === "secrets") {
        setSecretsProjectPath(options?.secretsProjectPath ?? null);
        setSecretsProjectId(options?.secretsProjectId ?? null);
      } else {
        setSecretsProjectPath(null);
        setSecretsProjectId(null);
      }
      router.navigateToSettings(nextSection);
    },
    [router]
  );

  const registerOnClose = useCallback((callback: () => void) => {
    closeCallbacksRef.current.add(callback);
    return () => {
      closeCallbacksRef.current.delete(callback);
    };
  }, []);

  // Fire close subscribers whenever settings transitions from open → closed,
  // regardless of how the navigation happened (explicit close, back button, etc.).
  const wasOpenRef = useRef(isOpen);
  useEffect(() => {
    if (wasOpenRef.current && !isOpen) {
      setProvidersExpandedProvider(null);
      setRuntimesProjectPath(null);
      setRuntimesProjectId(null);
      setSecretsProjectPath(null);
      setSecretsProjectId(null);
      for (const callback of closeCallbacksRef.current) {
        callback();
      }
    }
    wasOpenRef.current = isOpen;
  }, [isOpen]);

  const close = useCallback(() => {
    setProvidersExpandedProvider(null);
    setRuntimesProjectPath(null);
    setRuntimesProjectId(null);
    setSecretsProjectPath(null);
    setSecretsProjectId(null);
    router.navigateFromSettings();
  }, [router]);

  const setActiveSection = useCallback(
    (section: string) => {
      if (section !== "providers") {
        setProvidersExpandedProvider(null);
      }
      if (section !== "runtimes") {
        // Runtime scope hints are one-shot and should not persist across section changes.
        setRuntimesProjectPath(null);
        setRuntimesProjectId(null);
      }
      if (section !== "secrets") {
        setSecretsProjectPath(null);
        setSecretsProjectId(null);
      }
      router.navigateToSettings(section);
    },
    [router]
  );

  const value = useMemo<SettingsContextValue>(
    () => ({
      isOpen,
      activeSection,
      open,
      close,
      setActiveSection,
      registerOnClose,
      providersExpandedProvider,
      setProvidersExpandedProvider,
      runtimesProjectPath,
      setRuntimesProjectPath,
      runtimesProjectId,
      setRuntimesProjectId,
      secretsProjectPath,
      setSecretsProjectPath,
      secretsProjectId,
      setSecretsProjectId,
    }),
    [
      isOpen,
      activeSection,
      open,
      close,
      setActiveSection,
      registerOnClose,
      providersExpandedProvider,
      runtimesProjectPath,
      runtimesProjectId,
      secretsProjectPath,
      secretsProjectId,
    ]
  );

  return <SettingsContext.Provider value={value}>{props.children}</SettingsContext.Provider>;
}
