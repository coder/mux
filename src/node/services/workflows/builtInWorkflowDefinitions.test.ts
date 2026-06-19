/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, test } from "bun:test";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import { BUILT_IN_WORKFLOW_DEFINITIONS } from "./builtInWorkflowDefinitions";
import { WorkflowRunStore } from "./WorkflowRunStore";
import { WorkflowRunner, type WorkflowAgentResult, type WorkflowAgentSpec } from "./WorkflowRunner";

// Most fixtures use short leases so stale-run retry behavior stays fast.
const BUILT_IN_WORKFLOW_TEST_STALE_LEASE_MS = 100;

// 3e5ms timeouts below keep QuickJS-heavy workflow fixtures bounded by the 15m CI job;
// the compact literal avoids reflowing the large fixture bodies.
const deepResearch = BUILT_IN_WORKFLOW_DEFINITIONS.find(
  (definition) => definition.name === "deep-research"
);

async function runDeepResearchFixture(
  runId: string,
  args: unknown,
  taskCalls: WorkflowAgentSpec[],
  runAgent: (spec: WorkflowAgentSpec) => Promise<WorkflowAgentResult> | WorkflowAgentResult
) {
  if (!deepResearch) {
    throw new Error("Expected built-in deep-research workflow");
  }
  using tmp = new DisposableTempDir(runId);
  const runStore = new WorkflowRunStore({
    sessionDir: tmp.path,
    staleLeaseMs: BUILT_IN_WORKFLOW_TEST_STALE_LEASE_MS,
  });
  await runStore.createRun({
    id: runId,
    workspaceId: "workspace-1",
    definition: {
      name: deepResearch.name,
      description: deepResearch.description,
      scope: "built-in",
      executable: true,
    },
    definitionSource: deepResearch.source,
    args,
    now: "2026-05-29T00:00:00.000Z",
  });
  const runner = new WorkflowRunner({
    runStore,
    runtimeFactory: new QuickJSRuntimeFactory(),
    taskAdapter: {
      async runAgent(spec) {
        taskCalls.push(spec);
        return runAgent(spec);
      },
    },
    runnerId: "runner-a",
    clock: {
      nowIso: () => "2026-05-29T00:00:01.000Z",
      nowMs: () => 1_000,
    },
  });

  const result = await runner.run(runId);
  const run = await runStore.getRun(runId);
  return { result, run };
}

function expectSchemaHasNoOptionalObjectProperties(schema: unknown): void {
  if (!isRecord(schema)) return;
  const properties = schema.properties;
  if (isRecord(properties)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    expect(Object.keys(properties).filter((key) => !required.includes(key))).toEqual([]);
    Object.values(properties).forEach(expectSchemaHasNoOptionalObjectProperties);
  }
  if (schema.items !== undefined) {
    expectSchemaHasNoOptionalObjectProperties(schema.items);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

describe("built-in deep-research workflow", () => {
  test("coordinates staged research, verification, and final structured synthesis", async () => {
    if (!deepResearch) {
      throw new Error("Expected built-in deep-research workflow");
    }
    using tmp = new DisposableTempDir("deep-research-workflow");
    const runStore = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: BUILT_IN_WORKFLOW_TEST_STALE_LEASE_MS,
    });
    await runStore.createRun({
      id: "wfr_deep_research",
      workspaceId: "workspace-1",
      definition: {
        name: deepResearch.name,
        description: deepResearch.description,
        scope: "built-in",
        executable: true,
      },
      definitionSource: deepResearch.source,
      args: { topic: "durable workflow orchestration" },
      now: "2026-05-29T00:00:00.000Z",
    });

    const taskCalls: WorkflowAgentSpec[] = [];
    const runner = new WorkflowRunner({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(spec) {
          taskCalls.push(spec);
          if (spec.id.startsWith("verify-claim-0-vote-")) {
            return {
              taskId: `task_${spec.id}`,
              reportMarkdown: "Completed-step replay is supported.",
              structuredOutput: {
                claim: "Completed steps are reused on resume.",
                refuted: false,
                confidence: "high",
                evidence: "The runner reuses completed step results on resume.",
                counterSource: "",
              },
            };
          }
          if (spec.id.startsWith("verify-claim-1-vote-")) {
            const refuted = !spec.id.endsWith("-vote-0");
            return {
              taskId: `task_${spec.id}`,
              reportMarkdown: refuted
                ? "Structured output validation claim is overstated."
                : "Structured output validation is partly supported.",
              structuredOutput: {
                claim: "Structured outputs are validated at report time.",
                refuted,
                confidence: "medium",
                evidence: refuted
                  ? "The evidence does not show every structured output is validated at report time."
                  : "The workflow runner validates structured outputs for agent steps.",
                counterSource: "",
              },
            };
          }
          switch (spec.id) {
            case "scope-topic":
              return {
                taskId: "task_scope",
                reportMarkdown: "Research durable orchestration semantics.",
                structuredOutput: {
                  refinedTopic: "durable workflow orchestration",
                  strategy: "Compare implementation and tests for replay and validation semantics.",
                  questions: ["How are runs resumed?", "How are tasks verified?"],
                  angles: [
                    {
                      label: "implementation",
                      query: "durable workflow orchestration implementation",
                      rationale: "Read the runner implementation.",
                    },
                    {
                      label: "validation",
                      query: "durable workflow structured output validation tests",
                      rationale: "Check how tests cover validation behavior.",
                    },
                  ],
                },
              };
            case "discover-sources-0":
              return {
                taskId: "task_sources_0",
                reportMarkdown: "Found implementation and RFC.",
                structuredOutput: {
                  sources: [
                    {
                      title: "RFC",
                      url: "rfc/20260529_dynamic-workflows.md",
                      relevance: "high",
                      sourceType: "primary",
                    },
                  ],
                },
              };
            case "discover-sources-1":
              return {
                taskId: "task_sources_1",
                reportMarkdown: "Found runner source.",
                structuredOutput: {
                  sources: [
                    {
                      title: "RFC duplicate",
                      url: "rfc/20260529_dynamic-workflows.md?utm_source=duplicate",
                      relevance: "high",
                      sourceType: "primary",
                    },
                    {
                      title: "Runner",
                      url: "src/node/services/workflows/WorkflowRunner.ts",
                      relevance: "high",
                      sourceType: "primary",
                    },
                  ],
                },
              };
            case "extract-source-0":
              return {
                taskId: "task_extract_0",
                reportMarkdown: "RFC describes journal replay and validation.",
                structuredOutput: {
                  source: "RFC",
                  sourceQuality: "primary",
                  publishDate: "2026-05-29",
                  summary: "Defines durable runs and replay.",
                  claims: [
                    {
                      claim: "Completed steps are reused on resume.",
                      quote: "Defines durable runs and replay.",
                      importance: "central",
                    },
                  ],
                },
              };
            case "extract-source-1":
              return {
                taskId: "task_extract_1",
                reportMarkdown: "Runner describes replay lookup.",
                structuredOutput: {
                  source: "Runner",
                  sourceQuality: "primary",
                  publishDate: "",
                  summary: "Replays completed steps by hash.",
                  claims: [
                    {
                      claim: "Structured outputs are validated at report time.",
                      quote: "outputSchema validation runs for completed steps.",
                      importance: "supporting",
                    },
                  ],
                },
              };
            case "synthesize-report":
              return {
                taskId: "task_final",
                reportMarkdown: "# Deep Research\nDurable workflows replay completed steps.",
                structuredOutput: {
                  confidence: "medium",
                  gaps: ["Needs UI dogfood"],
                  findings: ["Replay"],
                },
              };
            default:
              throw new Error(`Unexpected deep-research step: ${spec.id}`);
          }
        },
      },
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await runner.run("wfr_deep_research");
    const run = await runStore.getRun("wfr_deep_research");

    expect(taskCalls.map((call) => call.id)).toEqual([
      "scope-topic",
      "discover-sources-0",
      "discover-sources-1",
      "extract-source-0",
      "extract-source-1",
      "verify-claim-0-vote-0",
      "verify-claim-0-vote-1",
      "verify-claim-0-vote-2",
      "verify-claim-1-vote-0",
      "verify-claim-1-vote-1",
      "verify-claim-1-vote-2",
      "synthesize-report",
    ]);
    expect(taskCalls.map((call) => call.agentId)).toEqual([
      "explore",
      "explore",
      "explore",
      "explore",
      "explore",
      "exec",
      "exec",
      "exec",
      "exec",
      "exec",
      "exec",
      "exec",
    ]);
    expect(taskCalls.every((call) => call.outputSchema != null)).toBe(true);
    taskCalls.forEach((call) => expectSchemaHasNoOptionalObjectProperties(call.outputSchema));
    expect(run.events.filter((event) => event.type === "phase").map((event) => event.name)).toEqual(
      [
        "scope",
        "source-discovery",
        "source-extraction",
        "claim-ranking",
        "adversarial-verification",
        "final-synthesis",
      ]
    );
    expect(result).toMatchObject({
      reportMarkdown: "# Deep Research\nDurable workflows replay completed steps.",
      structuredOutput: {
        topic: "durable workflow orchestration",
        refinedTopic: "durable workflow orchestration",
        mode: "smart",
        confidence: "medium",
        gaps: ["Needs UI dogfood"],
        findings: ["Replay"],
      },
    });
    const structuredOutput = (
      result as {
        structuredOutput: {
          claims: Array<{ claim: string }>;
          verification: Array<{
            claim: string;
            source: string;
            vote: string;
            refutedVotes: number;
            survives: boolean;
          }>;
          confirmedClaims: unknown[];
          refutedClaims: unknown[];
          stats: {
            claimsVerified: number;
            confirmed: number;
            killed: number;
            votesPerClaim: number;
            agentCalls: number;
          };
        };
      }
    ).structuredOutput;
    expect(structuredOutput.claims.map((claim) => claim.claim)).toEqual([
      "Completed steps are reused on resume.",
      "Structured outputs are validated at report time.",
    ]);
    expect(structuredOutput.verification).toEqual([
      {
        claim: "Completed steps are reused on resume.",
        source: "rfc/20260529_dynamic-workflows.md",
        vote: "3-0",
        refutedVotes: 0,
        survives: true,
      },
      {
        claim: "Structured outputs are validated at report time.",
        source: "src/node/services/workflows/WorkflowRunner.ts",
        vote: "1-2",
        refutedVotes: 2,
        survives: false,
      },
    ]);
    expect(structuredOutput.confirmedClaims).toHaveLength(1);
    expect(structuredOutput.refutedClaims).toHaveLength(1);
    expect(structuredOutput.stats).toMatchObject({
      claimsVerified: 2,
      confirmed: 1,
      killed: 1,
      sourceCandidates: 3,
      urlDupes: 1,
      votesPerClaim: 3,
      agentCalls: 12,
    });
  });

  test("skips empty source and claim fan-out stages", async () => {
    if (!deepResearch) {
      throw new Error("Expected built-in deep-research workflow");
    }
    using tmp = new DisposableTempDir("deep-research-empty-workflow");
    const runStore = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: BUILT_IN_WORKFLOW_TEST_STALE_LEASE_MS,
    });
    await runStore.createRun({
      id: "wfr_deep_research_empty",
      workspaceId: "workspace-1",
      definition: {
        name: deepResearch.name,
        description: deepResearch.description,
        scope: "built-in",
        executable: true,
      },
      definitionSource: deepResearch.source,
      args: { topic: "obscure empty topic" },
      now: "2026-05-29T00:00:00.000Z",
    });

    const taskCalls: WorkflowAgentSpec[] = [];
    const runner = new WorkflowRunner({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(spec) {
          taskCalls.push(spec);
          switch (spec.id) {
            case "scope-topic":
              return {
                taskId: "task_scope",
                reportMarkdown: "Scoped obscure topic.",
                structuredOutput: {
                  refinedTopic: "obscure empty topic",
                  strategy: "Try one broad source-discovery angle.",
                  questions: [],
                  angles: [
                    {
                      label: "general",
                      query: "obscure empty topic",
                      rationale: "Fallback search for any relevant source.",
                    },
                  ],
                },
              };
            case "discover-sources-0":
              return {
                taskId: "task_sources",
                reportMarkdown: "No high-signal sources found.",
                structuredOutput: { sources: [] },
              };
            default:
              throw new Error(`Unexpected deep-research step: ${spec.id}`);
          }
        },
      },
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await runner.run("wfr_deep_research_empty");
    const run = await runStore.getRun("wfr_deep_research_empty");

    expect(run.status).toBe("completed");
    expect(taskCalls.map((call) => call.id)).toEqual(["scope-topic", "discover-sources-0"]);
    expect(taskCalls.map((call) => call.agentId)).toEqual(["explore", "explore"]);
    expect(run.events.filter((event) => event.type === "phase").map((event) => event.name)).toEqual(
      ["scope", "source-discovery", "source-extraction", "claim-ranking"]
    );
    expect(result).toMatchObject({
      reportMarkdown:
        "# Deep Research\n\nNo verifiable claims were extracted from 0 selected sources. The research run stopped before adversarial verification.",
      structuredOutput: {
        sources: [],
        claims: [],
        verification: [],
        confidence: "low",
        gaps: ["No verifiable claims were extracted."],
        findings: [],
      },
    });
  });

  test("returns no-topic result without launching agents for missing or blank topics", async () => {
    const cases: Array<{ id: string; args: unknown }> = [
      { id: "empty_object", args: {} },
      { id: "mode_only", args: { mode: "quick" } },
      { id: "blank_topic", args: { topic: "   " } },
      { id: "blank_string", args: "" },
      { id: "null_args", args: null },
    ];

    for (const testCase of cases) {
      const taskCalls: WorkflowAgentSpec[] = [];
      const { result, run } = await runDeepResearchFixture(
        `wfr_deep_research_no_topic_${testCase.id}`,
        testCase.args,
        taskCalls,
        async (spec) => {
          throw new Error(`No agent should launch for missing topic; got ${spec.id}`);
        }
      );

      expect(run.status).toBe("completed");
      expect(taskCalls).toEqual([]);
      expect(result).toMatchObject({
        reportMarkdown: "# Deep Research\n\nNo research topic was provided.",
        structuredOutput: {
          topic: "",
          refinedTopic: "",
          sources: [],
          claims: [],
          verification: [],
          confidence: "low",
          gaps: ["No research topic was provided."],
        },
      });
    }
  });

  test("filters extracted claims that have no supporting quote", async () => {
    const taskCalls: WorkflowAgentSpec[] = [];
    const { result } = await runDeepResearchFixture(
      "wfr_deep_research_empty_quote_filter",
      { topic: "evidence filtering" },
      taskCalls,
      async (spec) => {
        if (spec.id.startsWith("verify-claim-")) {
          return {
            taskId: `task_${spec.id}`,
            reportMarkdown: "Verified supported claim.",
            structuredOutput: {
              claim: "Supported claim",
              refuted: false,
              confidence: "high",
              evidence: "The claim has a quote.",
              counterSource: "",
            },
          };
        }
        switch (spec.id) {
          case "scope-topic":
            return {
              taskId: "task_scope",
              reportMarkdown: "Scoped.",
              structuredOutput: {
                refinedTopic: "evidence filtering",
                strategy: "Read one source.",
                questions: ["Which claims have evidence?"],
                angles: [
                  { label: "primary", query: "evidence filtering", rationale: "Use one source." },
                ],
              },
            };
          case "discover-sources-0":
            return {
              taskId: "task_sources",
              reportMarkdown: "Found source.",
              structuredOutput: {
                sources: [
                  { title: "Source", url: "source.md", relevance: "high", sourceType: "primary" },
                ],
              },
            };
          case "extract-source-0":
            return {
              taskId: "task_extract",
              reportMarkdown: "Extracted claims.",
              structuredOutput: {
                source: "Source",
                sourceQuality: "primary",
                publishDate: "",
                summary: "One supported and one unsupported claim.",
                claims: [
                  { claim: "Unsupported claim", quote: "   ", importance: "central" },
                  { claim: "Supported claim", quote: "Direct evidence", importance: "supporting" },
                ],
              },
            };
          case "synthesize-report":
            return {
              taskId: "task_final",
              reportMarkdown: "# Evidence filtering",
              structuredOutput: { confidence: "high", gaps: [], findings: ["Supported claim"] },
            };
          default:
            throw new Error(`Unexpected deep-research step: ${spec.id}`);
        }
      }
    );

    const structuredOutput = (
      result as { structuredOutput: { claims: Array<{ claim: string }>; verification: unknown[] } }
    ).structuredOutput;
    expect(structuredOutput.claims.map((claim) => claim.claim)).toEqual(["Supported claim"]);
    expect(
      taskCalls.filter((call) => call.id.startsWith("verify-claim-")).map((call) => call.id)
    ).toEqual(["verify-claim-0-vote-0", "verify-claim-0-vote-1", "verify-claim-0-vote-2"]);
    expect(structuredOutput.verification).toHaveLength(1);
  });

  test("treats verifier claim identity mismatches as refutations", async () => {
    const taskCalls: WorkflowAgentSpec[] = [];
    const { result } = await runDeepResearchFixture(
      "wfr_deep_research_vote_identity",
      { topic: "claim identity" },
      taskCalls,
      async (spec) => {
        if (spec.id.startsWith("verify-claim-")) {
          const mismatched = !spec.id.endsWith("-vote-2");
          return {
            taskId: `task_${spec.id}`,
            reportMarkdown: mismatched ? "Wrong claim." : "Right claim.",
            structuredOutput: {
              claim: mismatched ? "Different claim" : "Identity-sensitive claim",
              refuted: false,
              confidence: "high",
              evidence: mismatched
                ? "This response evaluated a different claim."
                : "The expected claim is supported.",
              counterSource: "",
            },
          };
        }
        switch (spec.id) {
          case "scope-topic":
            return {
              taskId: "task_scope",
              reportMarkdown: "Scoped.",
              structuredOutput: {
                refinedTopic: "claim identity",
                strategy: "Use one claim.",
                questions: ["Can verifier identity drift?"],
                angles: [
                  { label: "primary", query: "claim identity", rationale: "Use one source." },
                ],
              },
            };
          case "discover-sources-0":
            return {
              taskId: "task_sources",
              reportMarkdown: "Found source.",
              structuredOutput: {
                sources: [
                  { title: "Source", url: "identity.md", relevance: "high", sourceType: "primary" },
                ],
              },
            };
          case "extract-source-0":
            return {
              taskId: "task_extract",
              reportMarkdown: "Extracted claim.",
              structuredOutput: {
                source: "Source",
                sourceQuality: "primary",
                publishDate: "",
                summary: "One claim.",
                claims: [
                  {
                    claim: "Identity-sensitive claim",
                    quote: "Direct evidence",
                    importance: "central",
                  },
                ],
              },
            };
          case "synthesize-report":
            return {
              taskId: "task_final",
              reportMarkdown: "# Claim identity",
              structuredOutput: { confidence: "low", gaps: ["Verifier mismatches"], findings: [] },
            };
          default:
            throw new Error(`Unexpected deep-research step: ${spec.id}`);
        }
      }
    );

    const structuredOutput = (
      result as {
        structuredOutput: {
          verification: Array<{
            claim: string;
            source: string;
            vote: string;
            refutedVotes: number;
            survives: boolean;
          }>;
          confirmedClaims: unknown[];
          refutedClaims: unknown[];
        };
      }
    ).structuredOutput;
    expect(structuredOutput.verification).toEqual([
      {
        claim: "Identity-sensitive claim",
        source: "identity.md",
        vote: "1-2",
        refutedVotes: 2,
        survives: false,
      },
    ]);
    expect(structuredOutput.confirmedClaims).toHaveLength(0);
    expect(structuredOutput.refutedClaims).toHaveLength(1);
  });

  test("dedupes tracking-only source variants without dropping meaningful query or path-case variants", async () => {
    const taskCalls: WorkflowAgentSpec[] = [];
    const { result } = await runDeepResearchFixture(
      "wfr_deep_research_source_dedupe",
      { topic: "source dedupe" },
      taskCalls,
      async (spec) => {
        switch (spec.id) {
          case "scope-topic":
            return {
              taskId: "task_scope",
              reportMarkdown: "Scoped.",
              structuredOutput: {
                refinedTopic: "source dedupe",
                strategy: "Return similar-looking sources.",
                questions: ["Which URLs are distinct?"],
                angles: [
                  {
                    label: "sources",
                    query: "source dedupe",
                    rationale: "Check canonicalization.",
                  },
                ],
              },
            };
          case "discover-sources-0":
            return {
              taskId: "task_sources",
              reportMarkdown: "Found sources.",
              structuredOutput: {
                sources: [
                  {
                    title: "Doc 1",
                    url: "https://example.com/view?id=1",
                    relevance: "high",
                    sourceType: "primary",
                  },
                  {
                    title: "Doc 2",
                    url: "https://example.com/view?id=2",
                    relevance: "high",
                    sourceType: "primary",
                  },
                  {
                    title: "Upper path",
                    url: "src/Foo.ts",
                    relevance: "high",
                    sourceType: "primary",
                  },
                  {
                    title: "Lower path",
                    url: "src/foo.ts",
                    relevance: "high",
                    sourceType: "primary",
                  },
                  {
                    title: "Doc 1 tracking duplicate",
                    url: "https://www.example.com/view?utm_source=newsletter&id=1#section",
                    relevance: "high",
                    sourceType: "primary",
                  },
                ],
              },
            };
          default:
            if (spec.id.startsWith("extract-source-")) {
              return {
                taskId: `task_${spec.id}`,
                reportMarkdown: spec.id,
                structuredOutput: {
                  source: spec.id,
                  sourceQuality: "primary",
                  publishDate: "",
                  summary: "No claims needed for dedupe coverage.",
                  claims: [],
                },
              };
            }
            throw new Error(`Unexpected deep-research step: ${spec.id}`);
        }
      }
    );

    const structuredOutput = (
      result as {
        structuredOutput: { sources: Array<{ url: string }>; stats: { urlDupes: number } };
      }
    ).structuredOutput;
    expect(structuredOutput.sources.map((source) => source.url)).toEqual([
      "https://example.com/view?id=1",
      "https://example.com/view?id=2",
      "src/Foo.ts",
      "src/foo.ts",
    ]);
    expect(structuredOutput.stats.urlDupes).toBe(1);
    expect(
      taskCalls.filter((call) => call.id.startsWith("extract-source-")).map((call) => call.id)
    ).toEqual(["extract-source-0", "extract-source-1", "extract-source-2", "extract-source-3"]);
  });

  test("keeps prototype-key source identifiers during dedupe", async () => {
    const taskCalls: WorkflowAgentSpec[] = [];
    const { result } = await runDeepResearchFixture(
      "wfr_deep_research_source_dedupe_prototype_keys",
      { topic: "prototype key source dedupe" },
      taskCalls,
      async (spec) => {
        switch (spec.id) {
          case "scope-topic":
            return {
              taskId: "task_scope",
              reportMarkdown: "Scoped.",
              structuredOutput: {
                refinedTopic: "prototype key source dedupe",
                strategy: "Return prototype-like source identifiers.",
                questions: ["Which source keys collide with object prototypes?"],
                angles: [
                  {
                    label: "sources",
                    query: "prototype key source dedupe",
                    rationale: "Check source key trust boundaries.",
                  },
                ],
              },
            };
          case "discover-sources-0":
            return {
              taskId: "task_sources",
              reportMarkdown: "Found prototype-key sources.",
              structuredOutput: {
                sources: [
                  {
                    title: "Constructor",
                    url: "constructor",
                    relevance: "high",
                    sourceType: "primary",
                  },
                  {
                    title: "To string",
                    url: "toString",
                    relevance: "high",
                    sourceType: "primary",
                  },
                  {
                    title: "Has own property",
                    url: "hasOwnProperty",
                    relevance: "high",
                    sourceType: "primary",
                  },
                  {
                    title: "Proto",
                    url: "__proto__",
                    relevance: "high",
                    sourceType: "primary",
                  },
                  {
                    title: "Constructor tracking duplicate",
                    url: "constructor?utm_source=duplicate#section",
                    relevance: "high",
                    sourceType: "primary",
                  },
                ],
              },
            };
          default:
            if (spec.id.startsWith("extract-source-")) {
              return {
                taskId: `task_${spec.id}`,
                reportMarkdown: spec.id,
                structuredOutput: {
                  source: spec.id,
                  sourceQuality: "primary",
                  publishDate: "",
                  summary: "No claims needed for prototype-key dedupe coverage.",
                  claims: [],
                },
              };
            }
            throw new Error(`Unexpected deep-research step: ${spec.id}`);
        }
      }
    );

    const structuredOutput = (
      result as {
        structuredOutput: {
          sources: Array<{ url: string }>;
          stats: { sourcesFetched: number; urlDupes: number };
        };
      }
    ).structuredOutput;
    expect(structuredOutput.sources.map((source) => source.url)).toEqual([
      "constructor",
      "toString",
      "hasOwnProperty",
      "__proto__",
    ]);
    expect(structuredOutput.stats).toMatchObject({ sourcesFetched: 4, urlDupes: 1 });
    expect(
      taskCalls.filter((call) => call.id.startsWith("extract-source-")).map((call) => call.id)
    ).toEqual(["extract-source-0", "extract-source-1", "extract-source-2", "extract-source-3"]);
  });

  test("quick mode applies smaller caps, one-vote verification, and bounded verifier batches", async () => {
    const taskCalls: WorkflowAgentSpec[] = [];
    let activeVerifyTasks = 0;
    let maxActiveVerifyTasks = 0;
    const { result } = await runDeepResearchFixture(
      "wfr_deep_research_quick_mode",
      { topic: "quick caps", mode: "quick" },
      taskCalls,
      async (spec) => {
        if (spec.id.startsWith("verify-claim-")) {
          const claimIndex = Number(/verify-claim-(\d+)-vote-/.exec(spec.id)?.[1] ?? "0");
          activeVerifyTasks += 1;
          maxActiveVerifyTasks = Math.max(maxActiveVerifyTasks, activeVerifyTasks);
          await new Promise((resolve) => setTimeout(resolve, 0));
          activeVerifyTasks -= 1;
          return {
            taskId: `task_${spec.id}`,
            reportMarkdown: spec.id,
            structuredOutput: {
              claim: `Quick claim ${claimIndex}`,
              refuted: claimIndex === 0,
              confidence: "high",
              evidence:
                claimIndex === 0 ? "Single quick-mode vote refutes this claim." : "Supported.",
              counterSource: claimIndex === 0 ? "counter.example" : "",
            },
          };
        }
        if (spec.id === "scope-topic") {
          return {
            taskId: "task_scope",
            reportMarkdown: "Scoped.",
            structuredOutput: {
              refinedTopic: "quick caps",
              strategy: "Return more angles and sources than quick mode should use.",
              questions: ["How quick?"],
              angles: [0, 1, 2, 3].map((index) => ({
                label: `angle-${index}`,
                query: `quick caps ${index}`,
                rationale: "Stress quick-mode caps.",
              })),
            },
          };
        }
        if (spec.id.startsWith("discover-sources-")) {
          const angleIndex = Number(spec.id.replace("discover-sources-", ""));
          return {
            taskId: `task_${spec.id}`,
            reportMarkdown: spec.id,
            structuredOutput: {
              sources: Array.from({ length: 4 }, (_value, sourceIndex) => ({
                title: `Quick source ${angleIndex}-${sourceIndex}`,
                url: `quick-${angleIndex}-${sourceIndex}.md`,
                relevance: "high",
                sourceType: "primary",
              })),
            },
          };
        }
        if (spec.id.startsWith("extract-source-")) {
          const sourceIndex = Number(spec.id.replace("extract-source-", ""));
          return {
            taskId: `task_${spec.id}`,
            reportMarkdown: spec.id,
            structuredOutput: {
              source: spec.id,
              sourceQuality: "primary",
              publishDate: "",
              summary: "summary",
              claims: [
                { claim: `Quick claim ${sourceIndex}`, quote: "fixture", importance: "central" },
              ],
            },
          };
        }
        if (spec.id === "synthesize-report") {
          return {
            taskId: "task_final",
            reportMarkdown: "# Quick capped",
            structuredOutput: { confidence: "medium", gaps: [], findings: [] },
          };
        }
        throw new Error(`Unexpected deep-research step: ${spec.id}`);
      }
    );

    const callIds = taskCalls.map((call) => call.id);
    const structuredOutput = (
      result as {
        structuredOutput: {
          mode: string;
          sources: unknown[];
          claims: unknown[];
          verification: Array<{ vote: string; refutedVotes: number; survives: boolean }>;
          confirmedClaims: unknown[];
          refutedClaims: unknown[];
          stats: { votesPerClaim: number };
        };
      }
    ).structuredOutput;
    expect(callIds.filter((id) => id.startsWith("discover-sources-")).length).toBe(3);
    expect(callIds).not.toContain("discover-sources-3");
    expect(callIds.filter((id) => id.startsWith("extract-source-")).length).toBe(8);
    expect(callIds.filter((id) => id.startsWith("verify-claim-")).length).toBe(8);
    expect(maxActiveVerifyTasks).toBeLessThanOrEqual(4);
    expect(structuredOutput.mode).toBe("quick");
    expect(structuredOutput.sources).toHaveLength(8);
    expect(structuredOutput.claims).toHaveLength(8);
    expect(structuredOutput.stats.votesPerClaim).toBe(1);
    expect(structuredOutput.verification[0]).toMatchObject({
      vote: "0-1",
      refutedVotes: 1,
      survives: false,
    });
    expect(structuredOutput.confirmedClaims).toHaveLength(7);
    expect(structuredOutput.refutedClaims).toHaveLength(1);
  });

  test("dedupes exact claim text before spending verification budget", async () => {
    const taskCalls: WorkflowAgentSpec[] = [];
    const claimByIndex = ["Repeated central claim", "Unique central claim"];
    const { result } = await runDeepResearchFixture(
      "wfr_deep_research_duplicate_claim_budget",
      { topic: "duplicate claim budget", mode: "quick" },
      taskCalls,
      async (spec) => {
        if (spec.id.startsWith("verify-claim-")) {
          const claimIndex = Number(/verify-claim-(\d+)-vote-/.exec(spec.id)?.[1] ?? "0");
          const claim = claimByIndex[claimIndex];
          if (claim == null) {
            throw new Error(`Unexpected duplicate-claim verification index: ${claimIndex}`);
          }
          return {
            taskId: `task_${spec.id}`,
            reportMarkdown: spec.id,
            structuredOutput: {
              claim,
              refuted: false,
              confidence: "high",
              evidence: "The grouped claim is supported.",
              counterSource: "",
            },
          };
        }
        if (spec.id === "scope-topic") {
          return {
            taskId: "task_scope",
            reportMarkdown: "Scoped.",
            structuredOutput: {
              refinedTopic: "duplicate claim budget",
              strategy:
                "Return duplicate claims that would otherwise fill quick-mode verification.",
              questions: ["Do duplicate claims crowd out unique claims?"],
              angles: [
                {
                  label: "duplicates",
                  query: "duplicate claim budget",
                  rationale: "Stress exact claim grouping.",
                },
              ],
            },
          };
        }
        if (spec.id === "discover-sources-0") {
          return {
            taskId: "task_sources",
            reportMarkdown: "Found sources.",
            structuredOutput: {
              sources: Array.from({ length: 8 }, (_value, index) => ({
                title: `Duplicate source ${index}`,
                url: `duplicate-${index}.md`,
                relevance: "high",
                sourceType: "primary",
              })),
            },
          };
        }
        if (spec.id.startsWith("extract-source-")) {
          const sourceIndex = Number(spec.id.replace("extract-source-", ""));
          const claims = [
            {
              claim: "Repeated central claim",
              quote: `Repeated evidence ${sourceIndex}`,
              importance: "central",
            },
          ];
          if (sourceIndex === 7) {
            claims.push({
              claim: "Unique central claim",
              quote: "Unique evidence",
              importance: "central",
            });
          }
          return {
            taskId: `task_${spec.id}`,
            reportMarkdown: spec.id,
            structuredOutput: {
              source: spec.id,
              sourceQuality: "primary",
              publishDate: "",
              summary: "summary",
              claims,
            },
          };
        }
        if (spec.id === "synthesize-report") {
          return {
            taskId: "task_final",
            reportMarkdown: "# Duplicate claims grouped",
            structuredOutput: { confidence: "high", gaps: [], findings: ["Grouped claims"] },
          };
        }
        throw new Error(`Unexpected deep-research step: ${spec.id}`);
      }
    );

    const structuredOutput = (
      result as {
        structuredOutput: {
          claims: Array<{ claim: string; duplicateCount: number; evidence: unknown[] }>;
          verification: unknown[];
          stats: { claimsExtracted: number; claimsVerified: number };
        };
      }
    ).structuredOutput;
    expect(structuredOutput.claims.map((claim) => claim.claim)).toEqual([
      "Repeated central claim",
      "Unique central claim",
    ]);
    expect(structuredOutput.claims[0]).toMatchObject({
      claim: "Repeated central claim",
      duplicateCount: 8,
    });
    expect(structuredOutput.claims[0].evidence).toHaveLength(8);
    expect(
      taskCalls.filter((call) => call.id.startsWith("verify-claim-")).map((call) => call.id)
    ).toEqual(["verify-claim-0-vote-0", "verify-claim-1-vote-0"]);
    expect(structuredOutput.verification).toHaveLength(2);
    expect(structuredOutput.stats).toMatchObject({ claimsExtracted: 2, claimsVerified: 2 });
  });

  test("caps model-produced deep-research fan-out", async () => {
    if (!deepResearch) {
      throw new Error("Expected built-in deep-research workflow");
    }
    using tmp = new DisposableTempDir("deep-research-capped-workflow");
    // This fixture intentionally creates heavy parallel step persistence; use production
    // lease timing so the assertion covers fan-out caps, not 50ms renewal churn.
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_deep_research_capped",
      workspaceId: "workspace-1",
      definition: {
        name: deepResearch.name,
        description: deepResearch.description,
        scope: "built-in",
        executable: true,
      },
      definitionSource: deepResearch.source,
      args: { topic: "fanout cap" },
      now: "2026-05-29T00:00:00.000Z",
    });

    const taskCalls: WorkflowAgentSpec[] = [];
    let activeVerifyTasks = 0;
    let maxActiveVerifyTasks = 0;
    const runner = new WorkflowRunner({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(spec) {
          taskCalls.push(spec);
          if (spec.id === "scope-topic") {
            return {
              taskId: "task_scope",
              reportMarkdown: "Scoped.",
              structuredOutput: {
                refinedTopic: "fanout cap",
                strategy: "Return more sources and claims than the workflow should fan out to.",
                questions: ["How much fanout?"],
                angles: [
                  {
                    label: "fanout",
                    query: "fanout cap",
                    rationale: "Stress source and claim caps.",
                  },
                ],
              },
            };
          }
          if (spec.id === "discover-sources-0") {
            return {
              taskId: "task_sources",
              reportMarkdown: "Many sources.",
              structuredOutput: {
                sources: Array.from({ length: 20 }, (_value, index) => ({
                  title: `Source ${index}`,
                  url: `source-${index}.md`,
                  relevance: "high",
                  sourceType: "primary",
                })),
              },
            };
          }
          if (spec.id.startsWith("extract-source-")) {
            const sourceIndex = Number(spec.id.replace("extract-source-", ""));
            return {
              taskId: `task_${spec.id}`,
              reportMarkdown: spec.id,
              structuredOutput: {
                source: spec.id,
                sourceQuality: "primary",
                publishDate: "",
                summary: "summary",
                claims: Array.from({ length: 8 }, (_value, claimIndex) => ({
                  claim: `Claim ${sourceIndex}-${claimIndex}`,
                  quote: "fixture",
                  importance: "central",
                })),
              },
            };
          }
          if (spec.id.startsWith("verify-claim-")) {
            const claimIndex = Number(/verify-claim-(\d+)-vote-/.exec(spec.id)?.[1] ?? "0");
            activeVerifyTasks += 1;
            maxActiveVerifyTasks = Math.max(maxActiveVerifyTasks, activeVerifyTasks);
            await new Promise((resolve) => setTimeout(resolve, 0));
            activeVerifyTasks -= 1;
            return {
              taskId: `task_${spec.id}`,
              reportMarkdown: spec.id,
              structuredOutput: {
                claim: `Claim ${Math.floor(claimIndex / 5)}-${claimIndex % 5}`,
                refuted: false,
                confidence: "high",
                evidence: "fixture support",
                counterSource: "",
              },
            };
          }
          if (spec.id === "synthesize-report") {
            return {
              taskId: "task_final",
              reportMarkdown: "# Capped",
              structuredOutput: { confidence: "medium", gaps: [], findings: [] },
            };
          }
          throw new Error(`Unexpected deep-research step: ${spec.id}`);
        },
      },
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await runner.run("wfr_deep_research_capped");
    const callIds = taskCalls.map((call) => call.id);

    expect(callIds.filter((id) => id.startsWith("extract-source-")).length).toBe(15);
    expect(callIds.filter((id) => id.startsWith("verify-claim-")).length).toBe(48);
    expect(maxActiveVerifyTasks).toBeLessThanOrEqual(12);
    expect(callIds).not.toContain("extract-source-15");
    expect(callIds).not.toContain("verify-claim-16-vote-0");
    const structuredOutput = (
      result as {
        structuredOutput: {
          sources: unknown[];
          sourceExtracts: Array<{ claims: unknown[] }>;
          claims: unknown[];
          verification: unknown[];
          stats: { claimsExtracted: number };
        };
      }
    ).structuredOutput;
    expect(structuredOutput.sources).toHaveLength(15);
    expect(structuredOutput.sourceExtracts).toHaveLength(15);
    expect(structuredOutput.sourceExtracts.every((source) => source.claims.length === 5)).toBe(
      true
    );
    expect(structuredOutput.claims).toHaveLength(16);
    expect(structuredOutput.verification).toHaveLength(16);
    expect(structuredOutput.stats.claimsExtracted).toBe(75);
  }, 3e5);
});
