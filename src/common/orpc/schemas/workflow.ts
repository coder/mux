import { z } from "zod";

export const WorkflowNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const WorkflowScriptScopeValues = ["project", "global", "built-in"] as const;
const LegacyWorkflowScriptScopeValue = "scratch";

export const WorkflowScriptScopeSchema = z.preprocess(
  (value) => (value === LegacyWorkflowScriptScopeValue ? "project" : value),
  z.enum(WorkflowScriptScopeValues)
);

export const WorkflowRunIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^wfr_[A-Za-z0-9_-]+$/);

export const WorkflowRunStatusSchema = z.enum([
  "pending",
  "running",
  "backgrounded",
  "interrupted",
  "completed",
  "failed",
]);

const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ])
);

// Kept only so older workflow run records with legacy host-step events remain parseable.
const LegacyWorkflowHostStepEffectSchema = z.enum(["read", "workspace", "external"]);

export const WorkflowMetadataSchema = z.record(z.string(), JsonValueSchema);

export const WorkflowArgSummarySchema = z
  .object({
    name: z.string().min(1),
    types: z.array(z.string().min(1)).min(1),
    required: z.boolean(),
    aliases: z.array(z.string().min(1)).optional(),
    negatedAliases: z.array(z.string().min(1)).optional(),
    positional: z.boolean().optional(),
    default: JsonValueSchema.optional(),
    enum: z.array(JsonValueSchema).optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
  })
  .strict();

export const WorkflowScriptDescriptorSchema = z
  .object({
    name: WorkflowNameSchema,
    description: z.string().min(1).max(1024),
    scope: WorkflowScriptScopeSchema,
    sourcePath: z.string().min(1).optional(),
    requestedScriptPath: z.string().min(1).optional(),
    canonicalScriptPath: z.string().min(1).optional(),
    sourceKind: z.enum(["skill", "workspace-file"]).optional(),
    sourceHash: z.string().min(1).optional(),
    executable: z.boolean(),
    blockedReason: z.string().min(1).optional(),
  })
  .refine((value) => value.executable || value.blockedReason != null, {
    message: "Non-executable workflow scripts must include a blocked reason",
    path: ["blockedReason"],
  });

export const WorkflowResultSchema = z.object({
  reportMarkdown: z.string(),
  structuredOutput: JsonValueSchema.optional(),
});

export const StructuredTaskOutputSchema = z.object({
  reportMarkdown: z.string(),
  title: z.string().min(1).nullable().optional(),
  structuredOutput: JsonValueSchema.optional(),
  taskId: z.string().min(1).optional(),
});

export const WorkflowRunEventSchema = z.discriminatedUnion("type", [
  z.object({
    sequence: z.number().int().positive(),
    type: z.literal("status"),
    at: IsoDateTimeSchema,
    status: WorkflowRunStatusSchema,
  }),
  z.object({
    sequence: z.number().int().positive(),
    type: z.literal("phase"),
    at: IsoDateTimeSchema,
    name: z.string().min(1),
    details: JsonValueSchema.optional(),
  }),
  z.object({
    sequence: z.number().int().positive(),
    type: z.literal("log"),
    at: IsoDateTimeSchema,
    message: z.string().min(1),
    data: JsonValueSchema.optional(),
  }),
  z.object({
    sequence: z.number().int().positive(),
    type: z.literal("task"),
    at: IsoDateTimeSchema,
    stepId: z.string().min(1),
    taskId: z.string().min(1),
    status: z.string().min(1),
    // Human-readable sub-agent title (matches the spawned workspace title).
    // Optional so legacy persisted events without it still parse.
    title: z.string().min(1).optional(),
  }),
  z.object({
    sequence: z.number().int().positive(),
    type: z.literal("workflow"),
    at: IsoDateTimeSchema,
    stepId: z.string().min(1),
    runId: WorkflowRunIdSchema,
    name: WorkflowNameSchema,
    status: z.enum(["started", "running", "backgrounded", "completed", "failed", "interrupted"]),
    details: JsonValueSchema.optional(),
  }),
  z.object({
    sequence: z.number().int().positive(),
    type: z.literal("patch"),
    at: IsoDateTimeSchema,
    stepId: z.string().min(1),
    sourceTaskId: z.string().min(1),
    status: z.enum(["started", "applied", "conflict", "failed"]),
    details: JsonValueSchema.optional(),
  }),
  z.object({
    sequence: z.number().int().positive(),
    type: z.literal("action"),
    at: IsoDateTimeSchema,
    stepId: z.string().min(1),
    name: z.string().min(1),
    status: z.enum(["started", "completed", "failed", "cached", "reconciled"]),
    effect: LegacyWorkflowHostStepEffectSchema,
    sourcePath: z.string().min(1).optional(),
    sourceHash: z.string().min(1).optional(),
    details: JsonValueSchema.optional(),
  }),
  z.object({
    sequence: z.number().int().positive(),
    type: z.literal("validation"),
    at: IsoDateTimeSchema,
    stepId: z.string().min(1),
    success: z.boolean(),
    message: z.string().min(1).optional(),
  }),
  z.object({
    sequence: z.number().int().positive(),
    type: z.literal("result"),
    at: IsoDateTimeSchema,
    result: WorkflowResultSchema,
  }),
  z.object({
    sequence: z.number().int().positive(),
    type: z.literal("error"),
    at: IsoDateTimeSchema,
    message: z.string().min(1),
  }),
]);

export const WorkflowEventSequenceSchema = z
  .array(WorkflowRunEventSchema)
  .superRefine((events, ctx) => {
    let previousSequence = 0;
    for (const [index, event] of events.entries()) {
      if (event.sequence <= previousSequence) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Workflow events must be strictly ordered by increasing sequence",
          path: [index, "sequence"],
        });
      }
      previousSequence = event.sequence;
    }
  });

export const WorkflowStepStatusSchema = z.enum(["started", "completed", "failed", "interrupted"]);

export const WorkflowStepRecordSchema = z.object({
  stepId: z.string().min(1),
  inputHash: z.string().min(1),
  status: WorkflowStepStatusSchema,
  taskId: z.string().min(1).optional(),
  startedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.optional(),
  result: StructuredTaskOutputSchema.optional(),
  error: z.string().min(1).optional(),
});

const WorkflowRunStatusTransitions: Record<
  z.infer<typeof WorkflowRunStatusSchema>,
  ReadonlyArray<z.infer<typeof WorkflowRunStatusSchema>>
> = {
  pending: ["running", "backgrounded", "interrupted", "failed"],
  running: ["backgrounded", "interrupted", "completed", "failed"],
  backgrounded: ["running", "interrupted", "completed", "failed"],
  interrupted: ["running", "failed"],
  completed: [],
  failed: [],
};

export const WorkflowRunStatusTransitionSchema = z
  .object({
    from: WorkflowRunStatusSchema,
    to: WorkflowRunStatusSchema,
  })
  .refine((transition) => WorkflowRunStatusTransitions[transition.from].includes(transition.to), {
    message: "Invalid workflow run status transition",
    path: ["to"],
  });

export const WorkflowRunParentSchema = z
  .object({
    runId: WorkflowRunIdSchema,
    stepId: z.string().min(1),
    inputHash: z.string().min(1),
    depth: z.number().int().nonnegative(),
  })
  .strict();

export const WorkflowRunRecordSchema = z.object({
  id: WorkflowRunIdSchema,
  workspaceId: z.string().min(1),
  workflow: WorkflowScriptDescriptorSchema,
  source: z.string().min(1),
  sourceHash: z.string().min(1),
  args: JsonValueSchema,
  agentOutputSchemaRequired: z.boolean().optional(),
  parentWorkflow: WorkflowRunParentSchema.optional(),
  status: WorkflowRunStatusSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  events: WorkflowEventSequenceSchema,
  steps: z.array(WorkflowStepRecordSchema),
});
