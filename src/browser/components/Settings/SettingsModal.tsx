import React from "react";
import {
  Settings,
  Key,
  Cpu,
  X,
  FlaskConical,
  Bot,
  Keyboard,
  Layout,
  BrainCircuit,
  ShieldCheck,
  Server,
  Lock,
} from "lucide-react";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { Dialog, DialogContent, DialogTitle, VisuallyHidden } from "@/browser/components/ui/dialog";
import { GeneralSection } from "./sections/GeneralSection";
import { TasksSection } from "./sections/TasksSection";
import { ProvidersSection } from "./sections/ProvidersSection";
import { ModelsSection } from "./sections/ModelsSection";
import { System1Section } from "./sections/System1Section";
import { GovernorSection } from "./sections/GovernorSection";
import { Button } from "@/browser/components/ui/button";
import { MCPSettingsSection } from "./sections/MCPSettingsSection";
import { SecretsSection } from "./sections/SecretsSection";
import { LayoutsSection } from "./sections/LayoutsSection";
import { ExperimentsSection } from "./sections/ExperimentsSection";
import { KeybindsSection } from "./sections/KeybindsSection";
import type { SettingsSection } from "./types";

const BASE_SECTIONS: SettingsSection[] = [
  {
    id: "general",
    label: "General",
    icon: <Settings className="h-4 w-4" />,
    component: GeneralSection,
  },
  {
    id: "tasks",
    label: "Agents",
    icon: <Bot className="h-4 w-4" />,
    component: TasksSection,
  },
  {
    id: "providers",
    label: "Providers",
    icon: <Key className="h-4 w-4" />,
    component: ProvidersSection,
  },
  {
    id: "mcp",
    label: "MCP",
    icon: <Server className="h-4 w-4" />,
    component: MCPSettingsSection,
  },
  {
    id: "secrets",
    label: "Secrets",
    icon: <Lock className="h-4 w-4" />,
    component: SecretsSection,
  },
  {
    id: "models",
    label: "Models",
    icon: <Cpu className="h-4 w-4" />,
    component: ModelsSection,
  },
  {
    id: "layouts",
    label: "Layouts",
    icon: <Layout className="h-4 w-4" />,
    component: LayoutsSection,
  },
  {
    id: "experiments",
    label: "Experiments",
    icon: <FlaskConical className="h-4 w-4" />,
    component: ExperimentsSection,
  },
  {
    id: "keybinds",
    label: "Keybinds",
    icon: <Keyboard className="h-4 w-4" />,
    component: KeybindsSection,
  },
];

export function SettingsModal() {
  const { isOpen, close, activeSection, setActiveSection } = useSettings();
  const system1Enabled = useExperimentValue(EXPERIMENT_IDS.SYSTEM_1);
  const governorEnabled = useExperimentValue(EXPERIMENT_IDS.MUX_GOVERNOR);

  // Reset activeSection if the experiment is disabled
  React.useEffect(() => {
    if (!system1Enabled && activeSection === "system1") {
      setActiveSection(BASE_SECTIONS[0]?.id ?? "general");
    }
    if (!governorEnabled && activeSection === "governor") {
      setActiveSection(BASE_SECTIONS[0]?.id ?? "general");
    }
  }, [activeSection, setActiveSection, system1Enabled, governorEnabled]);

  // Build sections list based on enabled experiments
  let sections: SettingsSection[] = BASE_SECTIONS;
  if (system1Enabled) {
    sections = [
      ...sections,
      {
        id: "system1",
        label: "System 1",
        icon: <BrainCircuit className="h-4 w-4" />,
        component: System1Section,
      },
    ];
  }
  if (governorEnabled) {
    sections = [
      ...sections,
      {
        id: "governor",
        label: "Governor",
        icon: <ShieldCheck className="h-4 w-4" />,
        component: GovernorSection,
      },
    ];
  }

  const currentSection = sections.find((s) => s.id === activeSection) ?? sections[0];
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
            {sections.map((section) => (
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
