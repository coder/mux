import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "@/browser/contexts/RouterContext";

interface OpenSettingsOptions {
  /** When opening the Providers settings, expand the given provider. */
  expandProvider?: string;
}

interface SettingsContextValue {
  isOpen: boolean;
  activeSection: string;
  open: (section?: string, options?: OpenSettingsOptions) => void;
  close: () => void;
  setActiveSection: (section: string) => void;

  /** One-shot hint for ProvidersSection to expand a provider. */
  providersExpandedProvider: string | null;
  setProvidersExpandedProvider: (provider: string | null) => void;
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
      router.navigateToSettings(nextSection);
    },
    [router]
  );

  const close = useCallback(() => {
    setProvidersExpandedProvider(null);
    router.navigateFromSettings();
  }, [router]);

  const setActiveSection = useCallback(
    (section: string) => {
      if (section !== "providers") {
        setProvidersExpandedProvider(null);
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
      providersExpandedProvider,
      setProvidersExpandedProvider,
    }),
    [isOpen, activeSection, open, close, setActiveSection, providersExpandedProvider]
  );

  return <SettingsContext.Provider value={value}>{props.children}</SettingsContext.Provider>;
}
