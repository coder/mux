import type { z } from "zod";

import type {
  AdvisorDescriptorSchema,
  AdvisorFrontmatterSchema,
  AdvisorIssueSchema,
  AdvisorNameSchema,
  AdvisorPackageSchema,
  AdvisorScopeSchema,
} from "@/common/orpc/schemas/advisor";

export type AdvisorName = z.infer<typeof AdvisorNameSchema>;
export type AdvisorScope = z.infer<typeof AdvisorScopeSchema>;
export type AdvisorFrontmatter = z.infer<typeof AdvisorFrontmatterSchema>;
export type AdvisorDescriptor = z.infer<typeof AdvisorDescriptorSchema>;
export type AdvisorPackage = z.infer<typeof AdvisorPackageSchema>;
export type AdvisorIssue = z.infer<typeof AdvisorIssueSchema>;
