import type { Runtime } from "./Runtime";
import { LocalRuntime } from "./LocalRuntime";
import { SSHRuntime } from "./SSHRuntime";
import type { RuntimeConfig } from "@/common/types/runtime";
import { isIncompatibleRuntimeConfig } from "@/common/utils/runtimeCompatibility";

// Re-export for backward compatibility with existing imports
export { isIncompatibleRuntimeConfig };

/**
 * Error thrown when a workspace has an incompatible runtime configuration,
 * typically from a newer version of mux that added new runtime types.
 */
export class IncompatibleRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompatibleRuntimeError";
  }
}

/**
 * Create a Runtime instance based on the configuration
 */
export function createRuntime(config: RuntimeConfig): Runtime {
  // Check for incompatible configs from newer versions
  if (isIncompatibleRuntimeConfig(config)) {
    throw new IncompatibleRuntimeError(
      `This workspace uses a runtime configuration from a newer version of mux. ` +
        `Please upgrade mux to use this workspace.`
    );
  }

  switch (config.type) {
    case "local":
      return new LocalRuntime(config.srcBaseDir);

    case "ssh":
      return new SSHRuntime({
        host: config.host,
        srcBaseDir: config.srcBaseDir,
        identityFile: config.identityFile,
        port: config.port,
      });

    default: {
      const unknownConfig = config as { type?: string };
      throw new Error(`Unknown runtime type: ${unknownConfig.type ?? "undefined"}`);
    }
  }
}
