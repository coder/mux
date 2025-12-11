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
import { useAPI } from "@/browser/contexts/API";
import type { EditorInfo } from "@/common/types/editor";

// Browser mode: window.api is not set (only exists in Electron via preload)
const isBrowserMode = typeof window !== "undefined" && !window.api;

export function GeneralSection() {
  const { theme, setTheme } = useTheme();
  const { api } = useAPI();
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [defaultEditor, setDefaultEditor] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [sshHost, setSshHost] = useState<string>("");
  const [sshHostLoaded, setSshHostLoaded] = useState(false);

  // Load editors from backend
  useEffect(() => {
    if (!api) return;

    const loadEditors = async () => {
      try {
        const editorList = await api.general.listEditors();
        setEditors(editorList);
        const current = editorList.find((e) => e.isDefault);
        if (current) {
          setDefaultEditor(current.id);
        }
      } catch (err) {
        console.error("Failed to load editors:", err);
      } finally {
        setLoading(false);
      }
    };

    void loadEditors();
  }, [api]);

  // Load SSH host from server on mount (browser mode only)
  useEffect(() => {
    if (isBrowserMode && api) {
      void api.server.getSshHost().then((host) => {
        setSshHost(host ?? "");
        setSshHostLoaded(true);
      });
    }
  }, [api]);

  const handleEditorChange = async (editorId: string) => {
    if (!api) return;

    // Optimistic update
    setDefaultEditor(editorId);
    setEditors((prev) =>
      prev.map((e) => ({
        ...e,
        isDefault: e.id === editorId,
      }))
    );

    try {
      await api.general.setDefaultEditor({ editorId });
    } catch (err) {
      console.error("Failed to set default editor:", err);
      // Revert on error
      const editorList = await api.general.listEditors();
      setEditors(editorList);
      const current = editorList.find((e) => e.isDefault);
      if (current) {
        setDefaultEditor(current.id);
      }
    }
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
          <div className="text-muted text-xs">
            Default editor for opening workspaces.{" "}
            <a
              href="https://mux.coder.com/docs/editor"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:underline"
            >
              Learn more
            </a>
          </div>
        </div>
        <Select
          value={defaultEditor}
          onValueChange={(value) => void handleEditorChange(value)}
          disabled={loading}
        >
          <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto cursor-pointer rounded-md border px-3 text-sm transition-colors">
            <SelectValue placeholder={loading ? "Loading..." : "Select editor"} />
          </SelectTrigger>
          <SelectContent>
            {editors.map((editor) => (
              <SelectItem key={editor.id} value={editor.id}>
                {editor.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

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
