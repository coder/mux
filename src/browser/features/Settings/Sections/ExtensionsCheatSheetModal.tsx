import { useEffect, useRef } from "react";
import { X } from "lucide-react";

import { trapTabKey } from "./dialogFocus";
import { Button } from "@/browser/components/Button/Button";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";

interface CheatSheetEntry {
  label: string;
  keybind: keyof typeof KEYBINDS;
  alt?: keyof typeof KEYBINDS;
}

const ENTRIES: readonly CheatSheetEntry[] = [
  { label: "Reload extensions", keybind: "EXTENSIONS_RELOAD" },
  { label: "Focus next / previous extension", keybind: "EXTENSIONS_NAVIGATE_NEXT" },
  {
    label: "Expand the focused extension",
    keybind: "EXTENSIONS_EXPAND_ENTER",
    alt: "EXTENSIONS_EXPAND_SPACE",
  },
  { label: "Enable / disable focused extension", keybind: "EXTENSIONS_TOGGLE_ENABLE" },
  { label: "Approve focused extension capabilities", keybind: "EXTENSIONS_GRANT" },
  { label: "Trust project-local Extensions root", keybind: "EXTENSIONS_TRUST_ROOT" },
  { label: "Show focused extension diagnostics", keybind: "EXTENSIONS_DIAGNOSTICS" },
  { label: "Toggle this cheat sheet", keybind: "EXTENSIONS_CHEATSHEET" },
];

export interface ExtensionsCheatSheetModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ExtensionsCheatSheetModal: React.FC<ExtensionsCheatSheetModalProps> = ({
  isOpen,
  onClose,
}) => {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    closeButtonRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;
  return (
    <div
      role="dialog"
      aria-labelledby="extensions-cheatsheet-title"
      className="fixed inset-0 z-[1500] flex items-center justify-center"
      data-testid="extensions-cheatsheet-modal"
    >
      <button
        type="button"
        aria-label="Close cheat sheet"
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        onKeyDown={(event) => trapTabKey(panelRef.current, event)}
        className="bg-background-secondary border-border-medium relative z-10 mx-4 w-full max-w-md rounded-md border p-4 shadow-xl"
      >
        <div className="flex items-start justify-between gap-2">
          <h3 id="extensions-cheatsheet-title" className="text-foreground text-sm font-semibold">
            Extensions keyboard shortcuts
          </h3>
          <Button
            ref={closeButtonRef}
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            aria-label="Close cheat sheet"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-muted mt-1 text-xs">
          Shortcuts only fire while the Extensions settings section is open and your focus is not
          inside an editable element.
        </p>
        <ul className="mt-3 space-y-1.5">
          {ENTRIES.map((entry) => {
            const primary = formatKeybind(KEYBINDS[entry.keybind]);
            const alt = entry.alt ? formatKeybind(KEYBINDS[entry.alt]) : null;
            return (
              <li key={entry.keybind} className="flex items-center justify-between gap-3 text-xs">
                <span className="text-muted">{entry.label}</span>
                <kbd className="bg-background-secondary text-foreground border-border-medium rounded border px-2 py-0.5 font-mono text-[11px]">
                  {alt ? `${primary} / ${alt}` : primary}
                </kbd>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
};
