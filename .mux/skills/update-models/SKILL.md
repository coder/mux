---
name: update-models
description: Upgrade models.json from LiteLLM upstream and prune models-extra entries that are now covered.
---

# Update Models

Refresh the LiteLLM pricing database (`models.json`) and remove entries from `models-extra.ts`
that upstream now covers accurately.

## File Map

| File                                      | Role                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `src/common/utils/tokens/models.json`     | LiteLLM upstream pricing/token-limit database (~1 MB JSON)                |
| `src/common/utils/tokens/models-extra.ts` | Local overrides for models missing or wrong in upstream                   |
| `src/common/utils/tokens/modelStats.ts`   | Runtime lookup: checks models-extra **first**, then models.json           |
| `src/common/constants/knownModels.ts`     | UI-facing model definitions (aliases, warm flags, tokenizer overrides)    |
| `scripts/update_models.ts`                | Fetches latest `model_prices_and_context_window.json` from LiteLLM GitHub |

## Procedure

### 1. Fetch the latest models.json

```bash
bun scripts/update_models.ts
```

This overwrites `src/common/utils/tokens/models.json` with the latest LiteLLM data.

### 2. Identify removable models-extra entries

For **each** model key in `models-extra.ts`, check whether upstream `models.json` now contains
a matching entry. The lookup keys follow the same logic as `modelStats.ts`:

- Bare model name (e.g., `gpt-5.2`)
- Provider-prefixed name (e.g., `openai/gpt-5.2`)

Use this script to print each `models-extra` entry, whether upstream has it, and which critical
fields differ:

```bash
bun -e '
import modelsJson from "./src/common/utils/tokens/models.json";
import { modelsExtra } from "./src/common/utils/tokens/models-extra";

const critical = [
  "max_input_tokens",
  "max_output_tokens",
  "input_cost_per_token",
  "output_cost_per_token",
  "cache_creation_input_token_cost",
  "cache_read_input_token_cost",
  "mode",
] as const;

function parseNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

for (const [model, extra] of Object.entries(modelsExtra)) {
  const provider = extra.litellm_provider ?? "";
  const candidates = [
    model,
    provider ? `${provider}/${model}` : null,
    provider ? `${provider}/${model}-cloud` : null,
  ].filter(Boolean) as string[];

  const foundKey = candidates.find((k) => (modelsJson as Record<string, unknown>)[k]);
  if (!foundKey) {
    console.log(`${model} | upstream=missing | decision=keep`);
    continue;
  }

  const upstream = (modelsJson as Record<string, Record<string, unknown>>)[foundKey];
  const diffs = critical.filter((field) => {
    const ev = extra[field];
    const uv = upstream[field];
    if (ev == null && uv == null) return false;
    const en = parseNum(ev);
    const un = parseNum(uv);
    return en != null || un != null ? en !== un : ev !== uv;
  });

  console.log(
    `${model} | upstream=${foundKey} | diffs=${diffs.join(",") || "none"} | decision=${
      diffs.length === 0 ? "remove" : "review"
    }`
  );
}
'
```

Then manually inspect each `review` entry to decide whether upstream is now accurate enough to
remove the local override.

### 3. Decide: remove, keep, or update

For each models-extra entry found upstream, compare the **critical fields**:

| Field                             | Priority                                       |
| --------------------------------- | ---------------------------------------------- |
| `max_input_tokens`                | Must match or be acceptable                    |
| `max_output_tokens`               | Must match or be acceptable                    |
| `input_cost_per_token`            | Must match exactly                             |
| `output_cost_per_token`           | Must match exactly                             |
| `cache_creation_input_token_cost` | Must match if present in extra                 |
| `cache_read_input_token_cost`     | Must match if present in extra                 |
| `mode`                            | Must match when provider routing depends on it |

**Decision matrix:**

- **Remove** from models-extra: upstream data matches on all critical fields (or upstream is
  strictly better—e.g., has cache costs that extra omitted).
- **Keep** in models-extra: upstream data is wrong (e.g., wrong context window, wrong pricing).
  Update the comment explaining _why_ it's kept.
- **Update** in models-extra: the model is in upstream but upstream has a specific field wrong.
  Only override the minimum necessary fields.

> Remember: `modelStats.ts` checks models-extra **first**. An entry in models-extra always
> wins over models.json, which means stale overrides will shadow corrected upstream data.

### 4. Remove entries from models-extra.ts

Delete the full object entry (key + value + preceding comment block) for each model being removed.
Keep the file clean — no orphaned comments or trailing commas.

After removal, if `models-extra.ts` is empty (all models are upstream), keep the file with just
the `ModelData` interface and an empty `modelsExtra` export:

```typescript
export const modelsExtra: Record<string, ModelData> = {};
```

### 5. Validate

Run these checks in order — all must pass:

```bash
# Type-check (catches import/type errors from removed entries)
make typecheck

# Unit tests for model lookups (catches broken pricing/limits)
bun test src/common/utils/tokens/modelStats.test.ts

# Known-models integration test — verifies every KNOWN_MODELS entry resolves
# through getModelStats() and has valid token limits and costs.
# This catches premature models-extra removals automatically.
bun test src/common/constants/knownModels.test.ts

# Model capabilities (uses models-extra data)
bun test src/common/utils/ai/modelCapabilities.test.ts
```

If any test hard-codes a value from a removed models-extra entry (e.g., asserting
`max_input_tokens === 272000` for a model that now resolves from upstream with a
different value), update the test expectation to match the new upstream data.

## Findings from 2026-02-23 update cycle

- Upstream LiteLLM had caught up on most previously custom entries; only one model
  (`gpt-5.3-codex`) still required a local `models-extra` entry.
- Several stale overrides were **worse** than upstream (e.g., lower max token limits or outdated
  `mode: "chat"` where upstream now uses `mode: "responses"`).
- `max_output_tokens` changed for some models without cost changes, so pruning decisions should
  always compare token limits in addition to pricing fields.

**Lesson:** default to removing local overrides once upstream is present, unless there is a
clear, documented mismatch that affects runtime behavior or cost accounting.

## Common Pitfalls

- **LiteLLM key format varies.** Some models use bare names (`gpt-5.2`), some use
  `provider/model` (`anthropic/claude-opus-4-6`). Always check both forms.
- **models-extra shadows upstream.** If you leave a stale entry in models-extra, users will
  get outdated pricing even after upstream is fixed. Always prune.
- **The `mode` field matters.** Some Codex models use `"responses"` mode instead of `"chat"`.
  If upstream has the wrong mode, keep the models-extra override.
- **Cache costs may be absent upstream.** If models-extra has cache pricing that upstream lacks,
  keep the entry (cache cost accuracy affects user-facing cost estimates).
