import React from "react";
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
import {
  EDITOR_CONFIG_KEY,
  DEFAULT_EDITOR_CONFIG,
  type EditorConfig,
  type EditorType,
} from "@/common/constants/storage";

const EDITOR_OPTIONS: Array<{ value: EditorType; label: string }> = [
  { value: "vscode", label: "VS Code" },
  { value: "cursor", label: "Cursor" },
  { value: "zed", label: "Zed" },
  { value: "custom", label: "Custom" },
];

export function GeneralSection() {
  const { theme, setTheme } = useTheme();
  const [editorConfig, setEditorConfig] = usePersistedState<EditorConfig>(
    EDITOR_CONFIG_KEY,
    DEFAULT_EDITOR_CONFIG
  );

  const handleEditorChange = (editor: EditorType) => {
    setEditorConfig((prev) => ({ ...prev, editor }));
  };

  const handleCustomCommandChange = (customCommand: string) => {
    setEditorConfig((prev) => ({ ...prev, customCommand }));
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-foreground mb-4 text-sm font-medium">Appearance</h3>
        <div className="flex items-center justify-between">
          <div>
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
      )}
    </div>
  );
}
