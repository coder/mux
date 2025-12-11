import React from "react";
import { Settings, Key, Cpu, X, Briefcase, FlaskConical } from "lucide-react";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { Dialog, DialogContent, DialogTitle, VisuallyHidden } from "@/browser/components/ui/dialog";
import { GeneralSection } from "./sections/GeneralSection";
import { ProvidersSection } from "./sections/ProvidersSection";
import { ModelsSection } from "./sections/ModelsSection";
import { Button } from "@/browser/components/ui/button";
import { ProjectSettingsSection } from "./sections/ProjectSettingsSection";
import { ExperimentsSection } from "./sections/ExperimentsSection";
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
    id: "projects",
    label: "Projects",
    icon: <Briefcase className="h-4 w-4" />,
    component: ProjectSettingsSection,
  },
  {
    id: "models",
    label: "Models",
    icon: <Cpu className="h-4 w-4" />,
    component: ModelsSection,
  },
  {
    id: "experiments",
    label: "Experiments",
    icon: <FlaskConical className="h-4 w-4" />,
    component: ExperimentsSection,
  },
];

export function SettingsModal() {
  const { isOpen, close, activeSection, setActiveSection } = useSettings();

  const currentSection = SECTIONS.find((s) => s.id === activeSection) ?? SECTIONS[0];
  const SectionComponent = currentSection.component;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent
        showCloseButton={false}
        maxWidth="800px"
        aria-describedby={undefined}
        className="flex h-[80vh] max-h-[600px] flex-col gap-0 overflow-hidden p-0 md:h-[70vh] md:flex-row"
      >
        {/* Visually hidden title for accessibility */}
        <VisuallyHidden>
          <DialogTitle>Settings</DialogTitle>
        </VisuallyHidden>
        {/* Sidebar - horizontal tabs on mobile, vertical on desktop */}
        <div className="border-border-medium flex shrink-0 flex-col border-b md:w-48 md:border-r md:border-b-0">
          <div className="border-border-medium flex h-12 items-center justify-between border-b px-4 md:justify-start">
            <span className="text-foreground text-sm font-semibold">Settings</span>
            {/* Close button in header on mobile only */}
            <Button
              variant="ghost"
              size="icon"
              onClick={close}
              className="h-6 w-6 md:hidden"
              aria-label="Close settings"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <nav className="flex gap-1 overflow-x-auto p-2 md:flex-1 md:flex-col md:overflow-y-auto">
            {SECTIONS.map((section) => (
              <Button
                key={section.id}
                variant="ghost"
                onClick={() => setActiveSection(section.id)}
                className={`flex h-auto shrink-0 items-center justify-start gap-2 rounded-md px-3 py-2 text-left text-sm whitespace-nowrap md:w-full ${
                  activeSection === section.id
                    ? "bg-accent/20 text-accent hover:bg-accent/20 hover:text-accent"
                    : "text-muted hover:bg-hover hover:text-foreground"
                }`}
              >
                {section.icon}
                {section.label}
              </Button>
            ))}
          </nav>
        </div>

        {/* Content */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="border-border-medium hidden h-12 items-center justify-between border-b px-6 md:flex">
            <span className="text-foreground text-sm font-medium">{currentSection.label}</span>
            <Button
              variant="ghost"
              size="icon"
              onClick={close}
              className="h-6 w-6"
              aria-label="Close settings"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 md:p-6">
            <SectionComponent />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
