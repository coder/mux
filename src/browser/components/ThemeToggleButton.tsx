import { MoonStar, SunMedium } from "lucide-react";
import { useTheme } from "@/browser/contexts/ThemeContext";
import { TooltipWrapper, Tooltip } from "./Tooltip";

export function ThemeToggleButton() {
  const { theme, toggleTheme } = useTheme();
  const label = theme === "light" ? "Switch to dark theme" : "Switch to light theme";
  const Icon = theme === "light" ? MoonStar : SunMedium;

  return (
    <TooltipWrapper>
      <button
        type="button"
        onClick={toggleTheme}
        className="border-border-light text-muted-foreground hover:border-border-medium/80 hover:bg-toggle-bg/70 focus-visible:ring-border-medium flex h-7 w-7 items-center justify-center rounded-md border bg-transparent transition-colors duration-150 focus-visible:ring-1"
        aria-label={label}
        data-testid="theme-toggle"
      >
        <Icon className="h-4 w-4" aria-hidden />
      </button>
      <Tooltip align="right">{label}</Tooltip>
    </TooltipWrapper>
  );
}
