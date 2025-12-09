import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface SettingsContextValue {
  isOpen: boolean;
  activeSection: string;
  open: (section?: string) => void;
  close: () => void;
  setActiveSection: (section: string) => void;
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

  const open = useCallback((section?: string) => {
    if (section) setActiveSection(section);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  const value = useMemo<SettingsContextValue>(
    () => ({
      isOpen,
      activeSection,
      open,
      close,
      setActiveSection,
    }),
    [isOpen, activeSection, open, close]
  );

  return <SettingsContext.Provider value={value}>{props.children}</SettingsContext.Provider>;
}
