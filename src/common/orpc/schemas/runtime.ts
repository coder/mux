import { z } from "zod";

export const RuntimeModeSchema = z.enum(["local", "ssh"]);

export const RuntimeConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(RuntimeModeSchema.enum.local),
    srcBaseDir: z
      .string()
      .meta({ description: "Base directory where all workspaces are stored (e.g., ~/.mux/src)" }),
  }),
  z.object({
    type: z.literal(RuntimeModeSchema.enum.ssh),
    host: z
      .string()
      .meta({ description: "SSH host (can be hostname, user@host, or SSH config alias)" }),
    srcBaseDir: z
      .string()
      .meta({ description: "Base directory on remote host where all workspaces are stored" }),
    identityFile: z
      .string()
      .optional()
      .meta({ description: "Path to SSH private key (if not using ~/.ssh/config or ssh-agent)" }),
    port: z.number().optional().meta({ description: "SSH port (default: 22)" }),
  }),
]);
