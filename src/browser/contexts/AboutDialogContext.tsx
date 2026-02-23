import { createContext, useContext, useState, type ReactNode } from "react";

interface AboutDialogContextValue {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

const AboutDialogContext = createContext<AboutDialogContextValue | null>(null);

export function useAboutDialog(): AboutDialogContextValue {
  const ctx = useContext(AboutDialogContext);
  if (!ctx) throw new Error("useAboutDialog must be used within AboutDialogProvider");
  return ctx;
}

export function AboutDialogProvider(props: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <AboutDialogContext.Provider
      value={{
        isOpen,
        open: () => setIsOpen(true),
        close: () => setIsOpen(false),
      }}
    >
      {props.children}
    </AboutDialogContext.Provider>
  );
}
