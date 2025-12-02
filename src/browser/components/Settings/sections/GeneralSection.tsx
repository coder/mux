import React from "react";
import { useTheme, THEME_OPTIONS, type ThemeMode } from "@/browser/contexts/ThemeContext";

export function GeneralSection() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-foreground mb-4 text-sm font-medium">Appearance</h3>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-foreground text-sm">Theme</div>
            <div className="text-muted text-xs">Choose your preferred theme</div>
          </div>
          <select
            value={theme}
            onChange={(e) => setTheme(e.target.value as ThemeMode)}
            className="border-border-medium bg-background-secondary hover:bg-hover h-9 cursor-pointer rounded-md border px-3 text-sm transition-colors focus:outline-none"
          >
            {THEME_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
