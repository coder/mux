import { z } from "zod";

export const GitHubRepoInfoSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  avatarUrl: z.string().url(),
});

export const ConfiguredProjectGitHubRepoInfoSchema = z.record(
  z.string(),
  GitHubRepoInfoSchema.nullable()
);

export type GitHubRepoInfo = z.infer<typeof GitHubRepoInfoSchema>;
export type ConfiguredProjectGitHubRepoInfo = z.infer<typeof ConfiguredProjectGitHubRepoInfoSchema>;
