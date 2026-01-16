import { MoonStar, SunMedium } from "lucide-react";
import { useTheme } from "@/browser/contexts/ThemeContext";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";

export function ThemeToggleButton() {
  const { theme, toggleTheme } = useTheme();
  const isLightTheme = theme === "light";
  const label = isLightTheme ? "Switch to dark theme" : "Switch to light theme";
  const Icon = isLightTheme ? MoonStar : SunMedium;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={toggleTheme}
          className="border-border-light text-muted-foreground hover:border-border-medium/80 hover:bg-toggle-bg/70 focus-visible:ring-border-medium flex h-5 w-5 items-center justify-center rounded-md border bg-transparent transition-colors duration-150 focus-visible:ring-1"
          aria-label={label}
          data-testid="theme-toggle"
        >
          <Icon className="h-3.5 w-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent align="end">{label}</TooltipContent>
    </Tooltip>
  );
}
