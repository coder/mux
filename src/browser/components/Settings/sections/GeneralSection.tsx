import React, { useEffect, useState, useCallback } from "react";
import { useTheme, THEME_OPTIONS, type ThemeMode } from "@/browser/contexts/ThemeContext";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/ui/select";
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
              <div className="text-muted text-xs">
                To render Nerd Font icons in TUIs, set this to a Nerd Font (e.g. JetBrainsMono Nerd
                Font)
              </div>
            </div>
            <Input
              value={terminalFontConfig.fontFamily}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                handleTerminalFontFamilyChange(e.target.value)
              }
              placeholder={DEFAULT_TERMINAL_FONT_CONFIG.fontFamily}
              className="border-border-medium bg-background-secondary h-9 w-80"
            />
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
