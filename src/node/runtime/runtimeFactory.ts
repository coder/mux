import type { Runtime } from "./Runtime";
import { LocalRuntime } from "./LocalRuntime";
import { SSHRuntime } from "./SSHRuntime";
import type { RuntimeConfig } from "@/common/types/runtime";

/**
 * Create a Runtime instance based on the configuration
 */
export function createRuntime(config: RuntimeConfig): Runtime {
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
