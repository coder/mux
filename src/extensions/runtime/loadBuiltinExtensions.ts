import type { HostApi } from "@/extensions/api/HostApi";
import { createExtensionContext } from "@/extensions/api/createExtensionContext";
import type { ExtensionModule } from "@/extensions/api/ExtensionModule";
import type { ExtensionRegistry } from "@/extensions/registry/ExtensionRegistry";
import { rightSidebarTabsBuiltinExtension } from "@/extensions/builtin/rightSidebarTabsBuiltinExtension";
import { reviewExtension } from "@/extensions/review/reviewExtension";

export function loadBuiltinExtensions(registry: ExtensionRegistry, hostApi: HostApi): void {
  const builtins: ExtensionModule[] = [rightSidebarTabsBuiltinExtension, reviewExtension];

  for (const ext of builtins) {
    try {
      ext.activate(
        createExtensionContext({
          extensionId: ext.id,
          registry,
          hostApi,
        })
      );
    } catch (error) {
      hostApi.reportError(`Failed to activate builtin extension: ${ext.id}`, error);
    }
  }
}
