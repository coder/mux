import type { Runtime } from "./Runtime";
import { LocalRuntime } from "./LocalRuntime";
import { RemoteRuntime } from "./RemoteRuntime";

/**
 * Remote runtimes that keep their global mux home at the canonical host-style `~/.mux`
 * should resolve global agents/skills from the host filesystem. Runtimes with their own
 * mux home (for example Docker's `/var/mux`) keep global reads on the runtime itself.
 */
export function shouldUseHostGlobalMuxFallback(runtime: Runtime): boolean {
  return runtime instanceof RemoteRuntime && runtime.getMuxHome() === "~/.mux";
}

/**
 * Return the runtime to use for reading global roots (`~/.mux/skills/`, `~/.mux/agents/`).
 *
 * SSH/Coder-SSH runtimes whose global mux home is the canonical `~/.mux` resolve global
 * reads from the host filesystem (via a `LocalRuntime`). Runtimes with their own mux home
 * (e.g. Docker's `/var/mux`) keep global reads on the runtime/container.
 */
export function resolveGlobalRuntime(runtime: Runtime, workspacePath: string): Runtime {
  return shouldUseHostGlobalMuxFallback(runtime) ? new LocalRuntime(workspacePath) : runtime;
}
