import { Settings, X } from "lucide-react";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { Button } from "@/browser/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/ui/tooltip";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";

interface SettingsButtonProps {
  onBeforeOpenSettings?: () => void;
}

export function SettingsButton(props: SettingsButtonProps) {
  const { isOpen, open, close } = useSettings();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            // Keep the titlebar control as a true toggle: when settings are already open,
            // this should behave like a close action and restore the previous route.
            if (isOpen) {
              close();
              return;
            }

            props.onBeforeOpenSettings?.();
            open();
          }}
          className="border-border-light text-muted-foreground hover:border-border-medium/80 hover:bg-toggle-bg/70 h-5 w-5 border"
          aria-label={isOpen ? "Close settings" : "Open settings"}
          data-testid="settings-button"
        >
          {isOpen ? (
            <X className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <Settings className="h-3.5 w-3.5" aria-hidden />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {isOpen ? "Close settings" : `Open settings (${formatKeybind(KEYBINDS.OPEN_SETTINGS)})`}
      </TooltipContent>
    </Tooltip>
  );
}
