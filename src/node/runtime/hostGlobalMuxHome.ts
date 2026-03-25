import type { Runtime } from "./Runtime";
import { RemoteRuntime } from "./RemoteRuntime";

/**
 * Remote runtimes that keep their global mux home at the canonical host-style `~/.mux`
 * should resolve global agents/skills from the host filesystem. Runtimes with their own
 * mux home (for example Docker's `/var/mux`) keep global reads on the runtime itself.
 */
export function shouldUseHostGlobalMuxFallback(runtime: Runtime): boolean {
  return runtime instanceof RemoteRuntime && runtime.getMuxHome() === "~/.mux";
}
