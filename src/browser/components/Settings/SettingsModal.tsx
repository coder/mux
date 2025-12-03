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
        className="bg-dark border-border flex h-[80vh] max-h-[600px] w-[95%] max-w-[800px] flex-col overflow-hidden rounded-lg border shadow-lg md:h-[70vh] md:flex-row"
      >
        {/* Sidebar - horizontal tabs on mobile, vertical on desktop */}
        <div className="border-border-medium flex shrink-0 flex-col border-b md:w-48 md:border-r md:border-b-0">
          <div className="border-border-medium flex h-12 items-center justify-between border-b px-4 md:justify-start">
            <span id="settings-title" className="text-foreground text-sm font-semibold">
              Settings
            </span>
            {/* Close button in header on mobile only */}
            <button
              type="button"
              onClick={handleClose}
              className="text-muted hover:text-foreground rounded p-1 transition-colors md:hidden"
              aria-label="Close settings"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <nav className="flex overflow-x-auto p-2 md:flex-1 md:flex-col md:overflow-y-auto">
            {SECTIONS.map((section) => (
              <button
                key={section.id}
                type="button"
                onClick={() => setActiveSection(section.id)}
                className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm whitespace-nowrap transition-colors md:w-full ${
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
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="border-border-medium hidden h-12 items-center justify-between border-b px-6 md:flex">
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
          <div className="flex-1 overflow-y-auto p-4 md:p-6">
            <SectionComponent />
          </div>
        </div>
      </div>
    </ModalOverlay>
  );
}
