import type { SSHConnectionConfig } from "../sshConnectionPool";
import { OpenSSHTransport } from "./OpenSSHTransport";
import { SSH2Transport } from "./SSH2Transport";
import type { SSHTransport } from "./SSHTransport";

export type {
  SSHTransport,
  SSHTransportConfig,
  SpawnOptions,
  PtyHandle,
  PtySessionParams,
} from "./SSHTransport";
export { OpenSSHTransport, SSH2Transport };

export function createSSHTransport(config: SSHConnectionConfig, useSSH2: boolean): SSHTransport {
  return useSSH2 ? new SSH2Transport(config) : new OpenSSHTransport(config);
}
