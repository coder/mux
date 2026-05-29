import type { z } from "zod";
import type {
  AgentSkillDescriptorSchema,
  AgentSkillFrontmatterSchema,
  AgentSkillIssueSchema,
  AgentSkillPackageSchema,
  AgentSkillScopeSchema,
  SkillNameSchema,
} from "@/common/orpc/schemas";

export type SkillName = z.infer<typeof SkillNameSchema>;

export type AgentSkillScope = z.infer<typeof AgentSkillScopeSchema>;

export type AgentSkillFrontmatter = z.infer<typeof AgentSkillFrontmatterSchema>;

export type AgentSkillDescriptor = z.infer<typeof AgentSkillDescriptorSchema>;

export type AgentSkillIssue = z.infer<typeof AgentSkillIssueSchema>;

export type AgentSkillPackage = z.infer<typeof AgentSkillPackageSchema>;
