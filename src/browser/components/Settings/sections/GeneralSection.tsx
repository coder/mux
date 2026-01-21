import React, { useEffect, useState, useCallback } from "react";
import { useTheme, THEME_OPTIONS, type ThemeMode } from "@/browser/contexts/ThemeContext";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/ui/select";
import { Button } from "@/browser/components/ui/button";
import { Input } from "@/browser/components/ui/input";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useAPI } from "@/browser/contexts/API";
import {
  EDITOR_CONFIG_KEY,
  DEFAULT_EDITOR_CONFIG,
  TERMINAL_FONT_CONFIG_KEY,
  DEFAULT_TERMINAL_FONT_CONFIG,
  type EditorConfig,
  type EditorType,
  type TerminalFontConfig,
} from "@/common/constants/storage";

const ALLOWED_EDITOR_TYPES: ReadonlySet<EditorType> = new Set([
  "vscode",
  "cursor",
  "zed",
  "custom",
]);

function normalizeEditorConfig(value: unknown): EditorConfig {
  if (!value || typeof value !== "object") {
    return DEFAULT_EDITOR_CONFIG;
  }

  const record = value as { editor?: unknown; customCommand?: unknown };
  const editor =
    typeof record.editor === "string" && ALLOWED_EDITOR_TYPES.has(record.editor as EditorType)
      ? (record.editor as EditorType)
      : DEFAULT_EDITOR_CONFIG.editor;

  const customCommand =
    typeof record.customCommand === "string" && record.customCommand.trim()
      ? record.customCommand
      : undefined;

  return { editor, customCommand };
}

const GENERIC_FONT_FAMILIES: ReadonlySet<string> = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
]);

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function quoteCssFontFamily(value: string): string {
  const trimmed = stripOuterQuotes(value);
  if (!trimmed) {
    return trimmed;
  }

  if (GENERIC_FONT_FAMILIES.has(trimmed.toLowerCase())) {
    return trimmed;
  }

  // Quote names containing whitespace or punctuation that would confuse CSS parsing.
  //
  // If the name itself contains quotes, strip them. A font-family name containing literal
  // quotes is almost certainly user input error and would produce invalid CSS.
  if (/[^a-zA-Z0-9_-]/.test(trimmed)) {
    const sanitized = trimmed.replace(/"/g, "");
    return `"${sanitized}"`;
  }

  return trimmed;
}

function splitFontFamilyList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function formatCssFontFamilyList(value: string): string {
  const parts = splitFontFamilyList(value);
  if (parts.length === 0) {
    return value.trim();
  }

  return parts.map(quoteCssFontFamily).join(", ");
}

function getPrimaryFontFamily(value: string): string | undefined {
  const first = splitFontFamilyList(value).at(0);
  if (!first) {
    return undefined;
  }

  const stripped = stripOuterQuotes(first);
  return stripped || undefined;
}

async function canLoadFontFamily(primary: string, fontSize: number): Promise<boolean> {
  if (typeof document === "undefined") {
    return true;
  }

  const family = stripOuterQuotes(primary).trim();
  if (!family) {
    return false;
  }

  if (GENERIC_FONT_FAMILIES.has(family.toLowerCase())) {
    return true;
  }

  const spec = `${fontSize}px ${quoteCssFontFamily(family)}`;

  if (!document.fonts?.load) {
    return document.fonts?.check ? document.fonts.check(spec) : true;
  }

  try {
    const faces = await document.fonts.load(spec);
    if (faces.length === 0) {
      return false;
    }
  } catch {
    // Ignore font load errors; fall back to check() when available.
  }

  return document.fonts?.check ? document.fonts.check(spec) : true;
}

async function filterFontFamiliesForBrowser(fonts: string[], fontSize: number): Promise<string[]> {
  const available: string[] = [];

  for (const family of fonts) {
    const trimmed = stripOuterQuotes(family).trim();
    if (!trimmed) {
      continue;
    }

    const ok = await canLoadFontFamily(trimmed, fontSize);
    if (ok) {
      available.push(trimmed);
    }
  }

  return Array.from(new Set(available));
}

function getTerminalFontAvailabilityWarning(config: TerminalFontConfig): string | undefined {
  if (typeof document === "undefined") {
    return undefined;
  }

  if (!document.fonts?.check) {
    return undefined;
  }

  const primary = getPrimaryFontFamily(config.fontFamily);
  if (!primary) {
    return undefined;
  }

  const normalizedPrimary = primary.trim();
  if (!normalizedPrimary) {
    return undefined;
  }

  if (GENERIC_FONT_FAMILIES.has(normalizedPrimary.toLowerCase())) {
    return undefined;
  }

  const wantsNerdFontIcons = config.fontFamily.toLowerCase().includes("nerd font");

  const primarySpec = `${config.fontSize}px ${quoteCssFontFamily(normalizedPrimary)}`;
  const primaryAvailable = document.fonts.check(primarySpec);
  if (!primaryAvailable) {
    if (normalizedPrimary.endsWith("Nerd Font") && !normalizedPrimary.endsWith("Nerd Font Mono")) {
      const monoCandidate = `${normalizedPrimary} Mono`;
      const monoSpec = `${config.fontSize}px ${quoteCssFontFamily(monoCandidate)}`;
      if (document.fonts.check(monoSpec)) {
        return `Font "${normalizedPrimary}" not found. Try "${monoCandidate}".`;
      }
    }

    return `Font "${normalizedPrimary}" not found in this browser.`;
  }

  if (!wantsNerdFontIcons) {
    return undefined;
  }

  // Nerd Font glyph checks: many TUIs now use Nerd Fonts v3 glyphs in the supplemental PUA.
  const nerdIconV2 = String.fromCodePoint(0xf15b);
  const nerdIconV3 = String.fromCodePoint(0xf024b);
  const formattedList = formatCssFontFamilyList(config.fontFamily);
  const stackSpec = `${config.fontSize}px ${formattedList}`;

  const hasV2Icon = document.fonts.check(stackSpec, nerdIconV2);
  if (!hasV2Icon) {
    return `Font "${normalizedPrimary}" is available, but Nerd Font icons weren't detected.`;
  }

  const hasV3Icon = document.fonts.check(stackSpec, nerdIconV3);
  if (!hasV3Icon) {
    return `Nerd Font icons detected, but Nerd Fonts v3 icons are missing (e.g. ${nerdIconV3}). Update your Nerd Font to a v3+ release.`;
  }

  return undefined;
}
function normalizeTerminalFontConfig(value: unknown): TerminalFontConfig {
  if (!value || typeof value !== "object") {
    return DEFAULT_TERMINAL_FONT_CONFIG;
  }

  const record = value as { fontFamily?: unknown; fontSize?: unknown };

  const fontFamily =
    typeof record.fontFamily === "string" && record.fontFamily.trim()
      ? record.fontFamily
      : DEFAULT_TERMINAL_FONT_CONFIG.fontFamily;

  const fontSizeNumber = Number(record.fontSize);
  const fontSize =
    Number.isFinite(fontSizeNumber) && fontSizeNumber > 0
      ? fontSizeNumber
      : DEFAULT_TERMINAL_FONT_CONFIG.fontSize;

  return { fontFamily, fontSize };
}

const EDITOR_OPTIONS: Array<{ value: EditorType; label: string }> = [
  { value: "vscode", label: "VS Code" },
  { value: "cursor", label: "Cursor" },
  { value: "zed", label: "Zed" },
  { value: "custom", label: "Custom" },
];

// Browser mode: window.api is not set (only exists in Electron via preload)
const isBrowserMode = typeof window !== "undefined" && !window.api;

export function GeneralSection() {
  const { theme, setTheme } = useTheme();
  const { api } = useAPI();
  const [rawTerminalFontConfig, setTerminalFontConfig] = usePersistedState<TerminalFontConfig>(
    TERMINAL_FONT_CONFIG_KEY,
    DEFAULT_TERMINAL_FONT_CONFIG
  );
  const terminalFontConfig = normalizeTerminalFontConfig(rawTerminalFontConfig);
  const terminalFontWarning = getTerminalFontAvailabilityWarning(terminalFontConfig);

  const [discoveredNerdFonts, setDiscoveredNerdFonts] = useState<string[]>([]);
  const [selectedDiscoveredNerdFont, setSelectedDiscoveredNerdFont] = useState<string>("");
  const [nerdFontDiscoveryError, setNerdFontDiscoveryError] = useState<string | null>(null);
  const [discoveringNerdFonts, setDiscoveringNerdFonts] = useState(false);

  const handleDiscoverNerdFonts = useCallback(() => {
    if (!api) {
      setNerdFontDiscoveryError("Font discovery is unavailable in this environment.");
      return;
    }

    setDiscoveringNerdFonts(true);
    setNerdFontDiscoveryError(null);

    api.server
      .listInstalledFonts({ filter: "nerd" })
      .then(async (result) => {
        setSelectedDiscoveredNerdFont("");

        const serverFonts = result.fonts;
        const browserFonts = await filterFontFamiliesForBrowser(
          serverFonts,
          terminalFontConfig.fontSize
        );

        setDiscoveredNerdFonts(browserFonts);

        if (result.error) {
          setNerdFontDiscoveryError(result.error);
          return;
        }

        if (serverFonts.length === 0) {
          setNerdFontDiscoveryError("No Nerd Fonts were detected on the server.");
          return;
        }

        if (browserFonts.length === 0) {
          setNerdFontDiscoveryError(
            `Found ${serverFonts.length} Nerd Font families on the mux server, but none are available in this browser.`
          );
        }
      })
      .catch((err) => {
        setNerdFontDiscoveryError(String(err));
      })
      .finally(() => {
        setDiscoveringNerdFonts(false);
      });
  }, [api, terminalFontConfig.fontSize]);

  const handleDiscoveredNerdFontSelect = (value: string) => {
    setSelectedDiscoveredNerdFont(value);
    handleTerminalFontFamilyChange(value);
  };
  const terminalFontPreviewFamily = formatCssFontFamilyList(terminalFontConfig.fontFamily);
  const terminalFontPreviewText = `${String.fromCodePoint(0xf024b)} ${String.fromCodePoint(0xf15b)}`;

  const [rawEditorConfig, setEditorConfig] = usePersistedState<EditorConfig>(
    EDITOR_CONFIG_KEY,
    DEFAULT_EDITOR_CONFIG
  );
  const editorConfig = normalizeEditorConfig(rawEditorConfig);
  const [sshHost, setSshHost] = useState<string>("");
  const [sshHostLoaded, setSshHostLoaded] = useState(false);

  // Load SSH host from server on mount (browser mode only)
  useEffect(() => {
    if (isBrowserMode && api) {
      void api.server.getSshHost().then((host) => {
        setSshHost(host ?? "");
        setSshHostLoaded(true);
      });
    }
  }, [api]);

  const handleEditorChange = (editor: EditorType) => {
    setEditorConfig((prev) => ({ ...normalizeEditorConfig(prev), editor }));
  };

  const handleTerminalFontFamilyChange = (fontFamily: string) => {
    setTerminalFontConfig((prev) => ({ ...normalizeTerminalFontConfig(prev), fontFamily }));
  };

  const handleTerminalFontSizeChange = (rawValue: string) => {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return;
    }

    setTerminalFontConfig((prev) => ({ ...normalizeTerminalFontConfig(prev), fontSize: parsed }));
  };
  const handleCustomCommandChange = (customCommand: string) => {
    setEditorConfig((prev) => ({ ...normalizeEditorConfig(prev), customCommand }));
  };

  const handleSshHostChange = useCallback(
    (value: string) => {
      setSshHost(value);
      // Save to server (debounced effect would be better, but keeping it simple)
      void api?.server.setSshHost({ sshHost: value || null });
    },
    [api]
  );

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-foreground mb-4 text-sm font-medium">Appearance</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Theme</div>
              <div className="text-muted text-xs">Choose your preferred theme</div>
            </div>
            <Select value={theme} onValueChange={(value) => setTheme(value as ThemeMode)}>
              <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto cursor-pointer rounded-md border px-3 text-sm transition-colors">
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
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Terminal Font</div>
              {terminalFontWarning ? (
                <div className="text-warning text-xs">{terminalFontWarning}</div>
              ) : null}
              <div className="text-muted text-xs">
                To render Nerd Font icons in TUIs, set this to a Nerd Font (e.g. JetBrainsMono Nerd
                Font)
              </div>
              {isBrowserMode ? (
                <div className="text-muted text-xs">
                  Browser mode uses fonts installed on this device. Discovered fonts come from the
                  mux server.
                </div>
              ) : null}
              <div className="text-muted text-xs">
                Preview:{" "}
                <span className="text-foreground" style={{ fontFamily: terminalFontPreviewFamily }}>
                  {terminalFontPreviewText}
                </span>
              </div>
            </div>
            <div className="flex flex-col items-end gap-2">
              <Input
                value={terminalFontConfig.fontFamily}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  handleTerminalFontFamilyChange(e.target.value)
                }
                placeholder={DEFAULT_TERMINAL_FONT_CONFIG.fontFamily}
                className="border-border-medium bg-background-secondary h-9 w-80"
              />

              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!api || discoveringNerdFonts}
                  onClick={handleDiscoverNerdFonts}
                >
                  {discoveringNerdFonts ? "Discovering…" : "Discover Nerd Fonts"}
                </Button>

                {discoveredNerdFonts.length > 0 ? (
                  <Select
                    value={selectedDiscoveredNerdFont || undefined}
                    onValueChange={handleDiscoveredNerdFontSelect}
                  >
                    <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-8 w-48 cursor-pointer rounded-md border px-3 text-xs transition-colors">
                      <SelectValue placeholder="Select Nerd Font" />
                    </SelectTrigger>
                    <SelectContent>
                      {discoveredNerdFonts.map((font) => (
                        <SelectItem key={font} value={font}>
                          {font}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
              </div>

              {nerdFontDiscoveryError ? (
                <div className="text-warning w-80 text-right text-xs">{nerdFontDiscoveryError}</div>
              ) : discoveredNerdFonts.length > 0 ? (
                <div className="text-muted w-80 text-right text-xs">
                  Found {discoveredNerdFonts.length} Nerd Font families
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Terminal Font Size</div>
              <div className="text-muted text-xs">Font size for the integrated terminal</div>
            </div>
            <Input
              type="number"
              value={terminalFontConfig.fontSize}
              min={6}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                handleTerminalFontSizeChange(e.target.value)
              }
              className="border-border-medium bg-background-secondary h-9 w-28"
            />
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <div className="text-foreground text-sm">Editor</div>
          <div className="text-muted text-xs">Editor to open files in</div>
        </div>
        <Select value={editorConfig.editor} onValueChange={handleEditorChange}>
          <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto cursor-pointer rounded-md border px-3 text-sm transition-colors">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EDITOR_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {editorConfig.editor === "custom" && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-foreground text-sm">Custom Command</div>
              <div className="text-muted text-xs">Command to run (path will be appended)</div>
            </div>
            <Input
              value={editorConfig.customCommand ?? ""}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                handleCustomCommandChange(e.target.value)
              }
              placeholder="e.g., nvim"
              className="border-border-medium bg-background-secondary h-9 w-40"
            />
          </div>
          {isBrowserMode && (
            <div className="text-warning text-xs">
              Custom editors are not supported in browser mode. Use VS Code or Cursor instead.
            </div>
          )}
        </div>
      )}

      {isBrowserMode && sshHostLoaded && (
        <div className="flex items-center justify-between">
          <div>
            <div className="text-foreground text-sm">SSH Host</div>
            <div className="text-muted text-xs">
              SSH hostname for &apos;Open in Editor&apos; deep links
            </div>
          </div>
          <Input
            value={sshHost}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              handleSshHostChange(e.target.value)
            }
            placeholder={window.location.hostname}
            className="border-border-medium bg-background-secondary h-9 w-40"
          />
        </div>
      )}
    </div>
  );
}
