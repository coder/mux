import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

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
  const [isOpen, setIsOpen] = useState(false);
  const [activeSection, setActiveSection] = useState(DEFAULT_SECTION);
  const [providersExpandedProvider, setProvidersExpandedProvider] = useState<string | null>(null);

  const setSection = useCallback((section: string) => {
    setActiveSection(section);

    if (section !== "providers") {
      setProvidersExpandedProvider(null);
    }
  }, []);

  const open = useCallback(
    (section?: string, options?: OpenSettingsOptions) => {
      if (section) {
        setSection(section);
      }

      if (section === "providers") {
        setProvidersExpandedProvider(options?.expandProvider ?? null);
      }

      setIsOpen(true);
    },
    [setSection]
  );

  const close = useCallback(() => {
    setIsOpen(false);
    setProvidersExpandedProvider(null);
  }, []);

  const value = useMemo<SettingsContextValue>(
    () => ({
      isOpen,
      activeSection,
      open,
      close,
      setActiveSection: setSection,
      providersExpandedProvider,
      setProvidersExpandedProvider,
    }),
    [isOpen, activeSection, open, close, providersExpandedProvider, setSection]
  );

  return <SettingsContext.Provider value={value}>{props.children}</SettingsContext.Provider>;
}
