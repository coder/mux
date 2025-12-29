import type { z } from "zod";
import type {
  AgentDefinitionDescriptorSchema,
  AgentDefinitionFrontmatterSchema,
  AgentDefinitionPackageSchema,
  AgentDefinitionScopeSchema,
  AgentIdSchema,
} from "@/common/orpc/schemas";

export type AgentId = z.infer<typeof AgentIdSchema>;

export type AgentDefinitionScope = z.infer<typeof AgentDefinitionScopeSchema>;

export type AgentDefinitionFrontmatter = z.infer<typeof AgentDefinitionFrontmatterSchema>;

export type AgentDefinitionDescriptor = z.infer<typeof AgentDefinitionDescriptorSchema>;

export type AgentDefinitionPackage = z.infer<typeof AgentDefinitionPackageSchema>;
