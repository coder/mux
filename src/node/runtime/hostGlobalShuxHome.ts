import { LEGACY_REMOTE_MUX_HOME } from "@/common/compat/legacyMux";
import type { Runtime } from "./Runtime";
import { LocalRuntime } from "./LocalRuntime";
import { RemoteRuntime } from "./RemoteRuntime";

/**
 * SSH runtimes retain the legacy remote home because local startup cannot safely migrate
 * arbitrary or offline hosts. Their global reads still resolve through the host's canonical
 * ~/.shux directory; Docker's separate /var/mux contract remains inside the container.
 */
export function shouldUseHostGlobalShuxFallback(runtime: Runtime): boolean {
  return runtime instanceof RemoteRuntime && runtime.getShuxHome() === LEGACY_REMOTE_MUX_HOME;
}

/** Return the runtime used to read global shux agent and skill roots. */
export function resolveGlobalRuntime(runtime: Runtime, workspacePath: string): Runtime {
  return shouldUseHostGlobalShuxFallback(runtime) ? new LocalRuntime(workspacePath) : runtime;
}
