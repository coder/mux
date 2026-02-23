/**
 * Maximum time (ms) to wait for the user to accept/reject a host-key
 * verification prompt in the UI dialog. Shared across:
 * - SshPromptService (auto-reject timeout)
 * - OpenSSH connection pool (probe deadline extension)
 */
export const HOST_KEY_APPROVAL_TIMEOUT_MS = 60_000;
