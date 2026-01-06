import React from "react";
import { Settings, Zap } from "lucide-react";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { Button } from "./ui/button";

/**
 * Large prompt displayed when no providers are configured.
 * Directs users to configure API providers before they can start using the app.
 */
export function ConfigureProvidersPrompt() {
  const settings = useSettings();

  const handleOpenProviders = () => {
    settings.open("providers");
  };

  return (
    <div
      className="border-border bg-card/50 flex flex-col items-center justify-center gap-4 rounded-lg border p-8 text-center"
      data-testid="configure-providers-prompt"
    >
      <div className="bg-primary/10 flex h-12 w-12 items-center justify-center rounded-full">
        <Zap className="text-primary h-6 w-6" />
      </div>
      <div className="space-y-2">
        <h2 className="text-foreground text-lg font-semibold">Configure an LLM Provider</h2>
        <p className="text-muted-foreground max-w-sm text-sm">
          To start a workspace, you&apos;ll need to configure at least one LLM provider with API
          credentials.
        </p>
      </div>
      <Button onClick={handleOpenProviders} className="gap-2">
        <Settings className="h-4 w-4" />
        Open Provider Settings
      </Button>
    </div>
  );
}
