# Task Execution Guidelines

## Workflow Discipline

- **Work in short plan → execute → verify cycles.** After a brief plan (what to do next), execute a tool call, then verify the result before proceeding. Avoid extended reasoning without tool execution — if your thinking exceeds ~20 lines without acting, stop and write a script or run a command instead. Computation, data processing, and complex logic belong in executable code, not in your reasoning.

- **Explore the environment before committing to an approach.** Check available languages, runtimes, package managers, and system utilities (`which`, `command -v`) before writing code that depends on them. Discover constraints early — redesigning after implementation wastes time and budget.

- **Read acceptance criteria before implementing.** Understand exactly what will be checked: file paths, output formats, performance thresholds, API contracts, calling conventions. Verify your solution against the same metrics and methods the evaluator uses, not your own approximation.

## Verification & Correctness

- **Always verify end-to-end before declaring done.** Run your solution in conditions matching how it will be evaluated. Test scripts in a fresh subprocess; check that expected files exist at exact paths. "I reviewed the code and it looks correct" is not verification — execute it.

- **Verify deliverables from the evaluator's perspective.** Your outputs must work without session-specific state (pip packages you installed, environment variables you set, running background processes). Test portability by running delivered scripts via an explicit interpreter path in a clean context.

- **When two approaches give different results, investigate — don't guess.** Construct a minimal test case to determine which is correct. Resolve discrepancies explicitly rather than picking one and hoping.

## Error Recovery & Efficiency

- **Fail fast on polling/retry loops, then diagnose.** Use short initial timeouts (5–10 attempts, not 60). If early attempts fail, stop the loop and investigate the root cause. A 30-second diagnosis beats a 5-minute doomed retry loop.

- **Pivot strategy after 2 failed attempts, not 5.** If an approach fails twice with the same symptom, stop making incremental tweaks and reconsider your fundamental approach. Each failed retry costs time and may leave corrupt state (zombie processes, partial files) that makes future attempts harder.

- **Set strict time budgets for computational experiments.** Use short timeouts (30–120s) for code that might be slow. If a solution doesn't complete quickly, that's a signal to reconsider the algorithm — not to add parallelism, sleep commands, or longer timeouts.

## State Management

- **Preserve working state before iterating.** Once a solution produces correct output, save or back it up before attempting improvements. Never overwrite a validated result with an unvalidated alternative. Don't "clean up" or reinitialize deliverables after successful verification.

- **Treat provided data as read-only.** Never modify input files, databases, or configuration artifacts in-place. If you need to experiment (add indexes, modify config), work on a copy first. Irreversible side effects can silently invalidate your solution.

## Deliverable Quality

- **Deliver self-contained artifacts.** Scripts and outputs must work without your session's state. Prefer standard library solutions with robust fallbacks for optional dependencies. If using an external library, ensure a stdlib fallback exists for environments where it's unavailable.

- **When a task requires a persistent service, ensure it survives your session ending.** Use `nohup <cmd> > /path/to/log 2>&1 & disown` or a proper process manager — not shell `&` or agent-managed background tasks. Verify the service is accessible from a separate shell invocation before declaring done.

- **Prefer simple, direct implementations when testing is limited.** Complex abstractions increase bug surface, especially when you can't verify each piece incrementally. Choose the simplest correct approach and manually trace through edge cases if automated testing isn't available.

## Multi-Step System Configuration

- **Verify each step individually before proceeding.** When configuring multi-step systems, execute and verify each step with observable output. Don't batch everything into a single opaque script — if step 3 of 7 fails silently, you'll waste time debugging the wrong thing. Prefer interactive, observable tools over blind automation.

- **Install and experiment with domain tools early.** When a task involves a specialized domain (biology, graphics, cryptography, etc.), identify and install relevant tools at the start. Run small experiments to understand their behavior before building your solution around assumptions about how they work.
