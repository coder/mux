import type { ExtensionContext } from "./createExtensionContext";

/**
 * Minimal extension module contract for in-process renderer extensions.
 *
 * Modules should be side-effect free on import; all registration should happen in activate().
 */
export interface ExtensionModule {
  id: string;
  activate: (ctx: ExtensionContext) => void;
}
