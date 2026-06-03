#!/usr/bin/env bash
# Generate src/node/services/workflows/builtInWorkflowContent.generated.ts

set -euo pipefail

bun scripts/gen_builtin_workflows.ts
