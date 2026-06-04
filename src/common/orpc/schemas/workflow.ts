import { z } from "zod";

export const WorkflowNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const WorkflowDefinitionScopeSchema = z.enum(["project", "global", "built-in", "scratch"]);

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
const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ])
);

export const WorkflowDefinitionDescriptorSchema = z
  .object({
    name: WorkflowNameSchema,
    description: z.string().min(1).max(1024),
    scope: WorkflowDefinitionScopeSchema,
    sourcePath: z.string().min(1).optional(),
    executable: z.boolean(),
    blockedReason: z.string().min(1).optional(),
  })
  .refine((value) => value.executable || value.blockedReason != null, {
    message: "Non-executable workflow definitions must include a blocked reason",
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

export const WorkflowRunRecordSchema = z.object({
  id: WorkflowRunIdSchema,
  workspaceId: z.string().min(1),
  definition: WorkflowDefinitionDescriptorSchema,
  definitionSource: z.string().min(1),
  definitionHash: z.string().min(1),
  args: JsonValueSchema,
  status: WorkflowRunStatusSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  events: WorkflowEventSequenceSchema,
  steps: z.array(WorkflowStepRecordSchema),
});
