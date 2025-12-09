/**
 * Docker SSH server fixture for runtime integration tests
 *
 * Features:
 * - Dynamic port allocation (no hardcoded ports)
 * - Ephemeral SSH key generation per test run
 * - Container lifecycle management
 * - Isolated test runs on same machine
 */

import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";

export interface SSHServerConfig {
  /** Container ID */
  containerId: string;
  /** Host to connect to (localhost:PORT) */
  host: string;
  /** Port on host mapped to container's SSH port */
  port: number;
  /** Path to private key file */
  privateKeyPath: string;
  /** Path to public key file */
  publicKeyPath: string;
  /** Working directory on remote host */
  workdir: string;
  /** Temp directory for keys */
  tempDir: string;
}

/**
 * Check if Docker is available
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    await execCommand("docker", ["version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Start SSH server in Docker container with dynamic port
 */
export async function startSSHServer(): Promise<SSHServerConfig> {
  // Create temp directory for SSH keys
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-ssh-test-"));
  let containerId: string | undefined;

  try {
    // Generate ephemeral SSH key pair
    const privateKeyPath = path.join(tempDir, "id_rsa");
    const publicKeyPath = path.join(tempDir, "id_rsa.pub");

    await execCommand("ssh-keygen", [
      "-t",
      "rsa",
      "-b",
      "2048",
      "-f",
      privateKeyPath,
      "-N",
      "", // No passphrase
      "-C",
      "mux-test",
    ]);

    // Read public key
    const publicKey = (await fs.readFile(publicKeyPath, "utf-8")).trim();

    // Build Docker image (use context directory for COPY commands)
    const dockerfilePath = path.join(__dirname, "ssh-server");
    await execCommand("docker", ["build", "-t", "mux-ssh-test", dockerfilePath]);

    // Generate unique container name to avoid conflicts
    const containerName = `mux-ssh-test-${crypto.randomBytes(8).toString("hex")}`;

    // Start container with dynamic port mapping
    // -p 0:22 tells Docker to assign a random available host port
    const runResult = await execCommand("docker", [
      "run",
      "-d",
      "--name",
      containerName,
      "-p",
      "0:22", // Dynamic port allocation
      "-e",
      `SSH_PUBLIC_KEY=${publicKey}`,
      "--rm", // Auto-remove on stop
      "mux-ssh-test",
    ]);

    containerId = runResult.stdout.trim();

    // Wait for container to be ready
    await waitForContainer(containerId);

    // Get the dynamically assigned port
    const portResult = await execCommand("docker", ["port", containerId, "22"]);

    // Port output format: "0.0.0.0:XXXXX" or "[::]:XXXXX"
    const portMatch = portResult.stdout.match(/:(\d+)/);
    if (!portMatch) {
      throw new Error(`Failed to parse port from: ${portResult.stdout}`);
    }
    const port = parseInt(portMatch[1], 10);

    // Wait for SSH to be ready
    await waitForSSH("localhost", port, privateKeyPath);

    return {
      containerId,
      host: `localhost:${port}`,
      port,
      privateKeyPath,
      publicKeyPath,
      workdir: "/home/testuser/workspace",
      tempDir,
    };
  } catch (error) {
    // Cleanup container on failure if it was started
    if (containerId) {
      try {
        await execCommand("docker", ["stop", containerId], { timeout: 10000 });
      } catch (cleanupError) {
        console.error("Error stopping container during cleanup:", cleanupError);
      }
    }
    // Cleanup temp directory on failure
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Stop SSH server and cleanup
 */
export async function stopSSHServer(config: SSHServerConfig): Promise<void> {
  try {
    // Stop container (--rm flag will auto-remove it)
    await execCommand("docker", ["stop", config.containerId], { timeout: 10000 });
  } catch (error) {
    console.error("Error stopping container:", error);
  }

  try {
    // Cleanup temp directory
    await fs.rm(config.tempDir, { recursive: true, force: true });
  } catch (error) {
    console.error("Error cleaning up temp directory:", error);
  }
}

/**
 * Wait for container to be in running state
 */
async function waitForContainer(containerId: string, maxAttempts = 30): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const result = await execCommand("docker", [
        "inspect",
        "-f",
        "{{.State.Running}}",
        containerId,
      ]);

      if (result.stdout.trim() === "true") {
        return;
      }
    } catch {
      // Container not ready yet
    }

    await sleep(100);
  }

  throw new Error(`Container ${containerId} did not start within timeout`);
}

/**
 * Wait for SSH to be ready by attempting to connect
 */
async function waitForSSH(
  host: string,
  port: number,
  privateKeyPath: string,
  maxAttempts = 30
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await execCommand(
        "ssh",
        [
          "-i",
          privateKeyPath,
          "-o",
          "StrictHostKeyChecking=no",
          "-o",
          "UserKnownHostsFile=/dev/null",
          "-o",
          "LogLevel=ERROR",
          "-o",
          "ConnectTimeout=1",
          "-p",
          port.toString(),
          "testuser@localhost",
          "echo ready",
        ],
        { timeout: 2000 }
      );

      // Success!
      return;
    } catch {
      // SSH not ready yet
    }

    await sleep(100);
  }

  throw new Error(`SSH at ${host}:${port} did not become ready within timeout`);
}

/**
 * Execute command and return result
 */
function execCommand(
  command: string,
  args: string[],
  options?: { timeout?: number }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(command, args);

    const timeout = options?.timeout
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
          reject(new Error(`Command timed out: ${command} ${args.join(" ")}`));
        }, options.timeout)
      : undefined;

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (timedOut) return;

      if (code === 0) {
        resolve({ stdout, stderr, exitCode: code ?? 0 });
      } else {
        reject(
          new Error(
            `Command failed with exit code ${code}: ${command} ${args.join(" ")}\nstderr: ${stderr}`
          )
        );
      }
    });

    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      if (timedOut) return;
      reject(error);
    });
  });
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
