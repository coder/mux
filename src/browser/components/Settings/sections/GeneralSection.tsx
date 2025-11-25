import React from "react";
import { MoonStar, SunMedium } from "lucide-react";
import { useTheme } from "@/browser/contexts/ThemeContext";

export function GeneralSection() {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-foreground mb-4 text-sm font-medium">Appearance</h3>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-foreground text-sm">Theme</div>
            <div className="text-muted text-xs">Choose light or dark appearance</div>
          </div>
          <button
            type="button"
            onClick={toggleTheme}
            className="border-border-medium bg-background-secondary hover:bg-hover flex h-9 items-center gap-2 rounded-md border px-3 text-sm transition-colors"
          >
            {theme === "light" ? (
              <>
                <SunMedium className="h-4 w-4" />
                <span>Light</span>
              </>
            ) : (
              <>
                <MoonStar className="h-4 w-4" />
                <span>Dark</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
