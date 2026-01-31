import React, { createContext, useContext, useState } from "react";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import type { HostApi } from "@/extensions/api/HostApi";
import { ExtensionRegistry } from "@/extensions/registry/ExtensionRegistry";
import { loadBuiltinExtensions } from "@/extensions/runtime/loadBuiltinExtensions";

const ExtensionRegistryContext = createContext<ExtensionRegistry | null>(null);

export function useExtensionRegistry(): ExtensionRegistry {
  const ctx = useContext(ExtensionRegistryContext);
  if (!ctx) throw new Error("useExtensionRegistry must be used within ExtensionRegistryProvider");
  return ctx;
}

export const ExtensionRegistryProvider: React.FC<{ children: React.ReactNode }> = (props) => {
  const [hostApi] = useState<HostApi>(() => ({
    storage: {
      read: readPersistedState,
      update: updatePersistedState,
    },
    reportError: (message, error) => console.error(message, error),
  }));

  const [registry] = useState(() => {
    const next = new ExtensionRegistry();

    try {
      loadBuiltinExtensions(next, hostApi);
    } catch (error) {
      hostApi.reportError("Failed to load builtin extensions", error);
    }

    return next;
  });

  return (
    <ExtensionRegistryContext.Provider value={registry}>
      {props.children}
    </ExtensionRegistryContext.Provider>
  );
};
