import * as fsPromises from "fs/promises";
import * as path from "path";

/**
 * SSH utilities service.
 */
export class SSHService {
  /**
   * Parse SSH config file and extract host definitions.
   * Returns list of configured hosts sorted alphabetically.
   */
  async getConfigHosts(): Promise<string[]> {
    const sshConfigPath = path.join(process.env.HOME ?? "", ".ssh", "config");
    try {
      const content = await fsPromises.readFile(sshConfigPath, "utf-8");
      const hosts = new Set<string>();

      // Parse Host directives - each can have multiple patterns separated by whitespace
      // Skip wildcards (*) and negation patterns (!)
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.toLowerCase().startsWith("host ")) {
          const patterns = trimmed.slice(5).trim().split(/\s+/);
          for (const pattern of patterns) {
            // Skip wildcards and negation patterns
            if (!pattern.includes("*") && !pattern.includes("?") && !pattern.startsWith("!")) {
              hosts.add(pattern);
            }
          }
        }
      }

      return Array.from(hosts).sort((a, b) => a.localeCompare(b));
    } catch {
      // File doesn't exist or can't be read - return empty list
      return [];
    }
  }
}
