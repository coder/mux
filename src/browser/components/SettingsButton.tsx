import { Settings } from "lucide-react";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { TooltipWrapper, Tooltip } from "./Tooltip";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";

export function SettingsButton() {
  const { open } = useSettings();

  return (
    <TooltipWrapper>
      <button
        type="button"
        onClick={() => open()}
        className="border-border-light text-muted-foreground hover:border-border-medium/80 hover:bg-toggle-bg/70 focus-visible:ring-border-medium flex h-5 w-5 items-center justify-center rounded-md border bg-transparent transition-colors duration-150 focus-visible:ring-1"
        aria-label="Open settings"
        data-testid="settings-button"
        data-tutorial="settings-button"
      >
        <Settings className="h-3.5 w-3.5" aria-hidden />
      </button>
      <Tooltip align="right">Settings ({formatKeybind(KEYBINDS.OPEN_SETTINGS)})</Tooltip>
    </TooltipWrapper>
  );
}
