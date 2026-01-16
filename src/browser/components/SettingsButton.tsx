import { Settings } from "lucide-react";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { Button } from "@/browser/components/ui/button";

export function SettingsButton() {
  const { open } = useSettings();

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => open()}
      className="border-border-light text-muted-foreground hover:border-border-medium/80 hover:bg-toggle-bg/70 h-5 w-5 border"
      aria-label="Open settings"
      data-testid="settings-button"
    >
      <Settings className="h-3.5 w-3.5" aria-hidden />
    </Button>
  );
}
