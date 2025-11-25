import React, { useEffect, useCallback } from "react";
import { Settings, Key, Cpu, X } from "lucide-react";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { ModalOverlay } from "@/browser/components/Modal";
import { matchesKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { GeneralSection } from "./sections/GeneralSection";
import { ProvidersSection } from "./sections/ProvidersSection";
import { ModelsSection } from "./sections/ModelsSection";
import type { SettingsSection } from "./types";

const SECTIONS: SettingsSection[] = [
  {
    id: "general",
    label: "General",
    icon: <Settings className="h-4 w-4" />,
    component: GeneralSection,
  },
  {
    id: "providers",
    label: "Providers",
    icon: <Key className="h-4 w-4" />,
    component: ProvidersSection,
  },
  {
    id: "models",
    label: "Models",
    icon: <Cpu className="h-4 w-4" />,
    component: ModelsSection,
  },
];

export function SettingsModal() {
  const { isOpen, close, activeSection, setActiveSection } = useSettings();

  const handleClose = useCallback(() => {
    close();
  }, [close]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesKeybind(e, KEYBINDS.CANCEL)) {
        e.preventDefault();
        handleClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleClose]);

  if (!isOpen) return null;

  const currentSection = SECTIONS.find((s) => s.id === activeSection) ?? SECTIONS[0];
  const SectionComponent = currentSection.component;

  return (
    <ModalOverlay role="presentation" onClick={handleClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(e) => e.stopPropagation()}
        className="bg-dark border-border flex h-[70vh] max-h-[600px] w-[90%] max-w-[800px] overflow-hidden rounded-lg border shadow-lg"
      >
        {/* Sidebar */}
        <div className="border-border-medium flex w-48 shrink-0 flex-col border-r">
          <div className="border-border-medium flex h-12 items-center border-b px-4">
            <span id="settings-title" className="text-foreground text-sm font-semibold">
              Settings
            </span>
          </div>
          <nav className="flex-1 overflow-y-auto p-2">
            {SECTIONS.map((section) => (
              <button
                key={section.id}
                type="button"
                onClick={() => setActiveSection(section.id)}
                className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  activeSection === section.id
                    ? "bg-accent/20 text-accent"
                    : "text-muted hover:bg-hover hover:text-foreground"
                }`}
              >
                {section.icon}
                {section.label}
              </button>
            ))}
          </nav>
        </div>

        {/* Content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="border-border-medium flex h-12 items-center justify-between border-b px-6">
            <span className="text-foreground text-sm font-medium">{currentSection.label}</span>
            <button
              type="button"
              onClick={handleClose}
              className="text-muted hover:text-foreground rounded p-1 transition-colors"
              aria-label="Close settings"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-6">
            <SectionComponent />
          </div>
        </div>
      </div>
    </ModalOverlay>
  );
}
