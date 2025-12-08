import { useTheme, THEME_OPTIONS, type ThemeMode } from "@/browser/contexts/ThemeContext";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/ui/select";

export function ThemeSelector() {
  const { theme, setTheme } = useTheme();
  const currentLabel = THEME_OPTIONS.find((t) => t.value === theme)?.label ?? theme;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Select value={theme} onValueChange={(value) => setTheme(value as ThemeMode)}>
          <SelectTrigger
            className="border-border-light text-muted-foreground hover:border-border-medium/80 hover:bg-toggle-bg/70 h-5 w-auto cursor-pointer border bg-transparent px-1.5 text-[11px] transition-colors duration-150"
            aria-label="Select theme"
            data-testid="theme-selector"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {THEME_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TooltipTrigger>
      <TooltipContent align="end">Theme: {currentLabel}</TooltipContent>
    </Tooltip>
  );
}
