import { z } from "zod";

export const MuxProviderOptionsSchema = z.object({
  anthropic: z
    .object({
      use1MContext: z.boolean().optional().meta({
        description: "Enable 1M context window (requires beta header)",
      }),
    })
    .optional(),
  openai: z
    .object({
      serviceTier: z.enum(["auto", "default", "flex", "priority"]).optional().meta({
        description:
          "OpenAI service tier: priority (low-latency), flex (50% cheaper, higher latency), auto/default (standard)",
      }),
      forceContextLimitError: z.boolean().optional().meta({
        description: "Force context limit error (used in integration tests to simulate overflow)",
      }),
      simulateToolPolicyNoop: z.boolean().optional().meta({
        description:
          "Simulate successful response without executing tools (used in tool policy tests)",
      }),
    })
    .optional(),
  google: z.record(z.string(), z.unknown()).optional(),
  ollama: z.record(z.string(), z.unknown()).optional(),
  openrouter: z.record(z.string(), z.unknown()).optional(),
  xai: z
    .object({
      searchParameters: z
        .object({
          mode: z.enum(["auto", "off", "on"]),
          returnCitations: z.boolean().optional(),
          fromDate: z.string().optional(),
          toDate: z.string().optional(),
          maxSearchResults: z.number().optional(),
          sources: z
            .array(
              z.discriminatedUnion("type", [
                z.object({
                  type: z.literal("web"),
                  country: z.string().optional(),
                  excludedWebsites: z.array(z.string()).optional(),
                  allowedWebsites: z.array(z.string()).optional(),
                  safeSearch: z.boolean().optional(),
                }),
                z.object({
                  type: z.literal("x"),
                  excludedXHandles: z.array(z.string()).optional(),
                  includedXHandles: z.array(z.string()).optional(),
                  postFavoriteCount: z.number().optional(),
                  postViewCount: z.number().optional(),
                  xHandles: z.array(z.string()).optional(),
                }),
                z.object({
                  type: z.literal("news"),
                  country: z.string().optional(),
                  excludedWebsites: z.array(z.string()).optional(),
                  safeSearch: z.boolean().optional(),
                }),
                z.object({
                  type: z.literal("rss"),
                  links: z.array(z.string()),
                }),
              ])
            )
            .optional(),
        })
        .optional(),
    })
    .optional(),
});
