#!/usr/bin/env bash
# Generate src/node/services/agentSkills/builtInSkillContent.generated.ts

set -euo pipefail

bun scripts/gen_builtin_skills.ts

echo "Generated src/node/services/agentSkills/builtInSkillContent.generated.ts"
