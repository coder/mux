import { Settings } from "lucide-react";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { Button } from "@/browser/components/ui/button";

export function SettingsButton() {
  const { open } = useSettings();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => open()}
          className="border-border-light text-muted-foreground hover:border-border-medium/80 hover:bg-toggle-bg/70 h-5 w-5 border"
          aria-label="Open settings"
          data-testid="settings-button"
          data-tutorial="settings-button"
        >
          <Settings className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent align="end">
        Settings ({formatKeybind(KEYBINDS.OPEN_SETTINGS)})
      </TooltipContent>
    </Tooltip>
  );
}
