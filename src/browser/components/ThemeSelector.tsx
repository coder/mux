import { useTheme, THEME_OPTIONS, type ThemeMode } from "@/browser/contexts/ThemeContext";
import { TooltipWrapper, Tooltip } from "./Tooltip";

export function ThemeSelector() {
  const { theme, setTheme } = useTheme();
  const currentLabel = THEME_OPTIONS.find((t) => t.value === theme)?.label ?? theme;

  return (
    <TooltipWrapper>
      <select
        value={theme}
        onChange={(e) => setTheme(e.target.value as ThemeMode)}
        className="border-border-light text-muted-foreground hover:border-border-medium/80 hover:bg-toggle-bg/70 focus-visible:ring-border-medium h-5 cursor-pointer appearance-none rounded-md border bg-transparent px-1.5 text-[11px] transition-colors duration-150 focus:outline-none focus-visible:ring-1"
        aria-label="Select theme"
        data-testid="theme-selector"
      >
        {THEME_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <Tooltip align="right">Theme: {currentLabel}</Tooltip>
    </TooltipWrapper>
  );
}
