import { useState, useEffect } from "react";

export interface AvailableScript {
  name: string;
  description?: string;
}

export function useAvailableScripts(workspaceId: string | null) {
  const [availableScripts, setAvailableScripts] = useState<AvailableScript[]>([]);

  useEffect(() => {
    // Clear scripts immediately to prevent stale suggestions from previous workspace
    setAvailableScripts([]);

    if (!workspaceId) {
      return;
    }

    let isMounted = true;

    const loadScripts = async () => {
      try {
        const result = await window.api.workspace.listScripts(workspaceId);
        if (isMounted) {
          if (result.success) {
            const executableScripts = result.data
              .filter((s) => s.isExecutable)
              .map((s) => ({ name: s.name, description: s.description }));
            setAvailableScripts(executableScripts);
          } else {
            // Clear scripts if listing fails
            setAvailableScripts([]);
          }
        }
      } catch (error) {
        console.error("Failed to load scripts:", error);
        if (isMounted) {
          setAvailableScripts([]);
        }
      }
    };

    void loadScripts();

    return () => {
      isMounted = false;
    };
  }, [workspaceId]);

  return availableScripts;
}
