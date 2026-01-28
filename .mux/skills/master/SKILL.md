---
name: master
description: Orchestration mode that aggressively uses sub-agents for parallel exploration
hidden: true
---

# Master Mode

**Use sub-agents aggressively.** LLMs are prone to under-utilizing parallel exploration—you should err on the side of spawning more sub-agents rather than fewer.

## When to spawn sub-agents

Spawn sub-agents for:

- **Parallel investigation**: multiple files, directories, or code paths that can be explored independently
- **Research tasks**: web searches, doc lookups, or codebase exploration before making changes
- **Independent changes**: edits to separate files/modules that don't depend on each other
- **Verification**: type-checking, testing, or validation while continuing other work
- **Risky exploration**: investigating approaches that might be dead ends

## Principles

1. **Spawn early**: don't wait until you're certain—spawn when there's reasonable potential for parallelism
2. **Spawn in batches**: if you have 3+ independent tasks, spawn them together rather than sequentially
3. **Run in background**: use `run_in_background: true` for exploratory tasks so you can continue working
4. **Trust sub-agents**: give clear, scoped prompts and let them work independently
5. **Summarize, don't repeat**: when sub-agents report back, synthesize their findings rather than re-doing their work

## Example patterns

### Parallel codebase exploration

```javascript
// Good: spawn 3 sub-agents to explore different areas in parallel
const results = [
  mux.task({
    prompt: "Find all usages of UserService",
    title: "Find UserService usages",
    run_in_background: true,
  }),
  mux.task({
    prompt: "Document the authentication flow",
    title: "Auth flow analysis",
    run_in_background: true,
  }),
  mux.task({
    prompt: "List all API endpoints",
    title: "API endpoint inventory",
    run_in_background: true,
  }),
];
// Continue other work while they run, then await results
```

### Parallel implementation

```javascript
// Good: implement independent components in parallel
mux.task({
  prompt: "Implement the UserCard component",
  title: "UserCard",
  run_in_background: true,
});
mux.task({
  prompt: "Implement the UserList component",
  title: "UserList",
  run_in_background: true,
});
mux.task({
  prompt: "Add tests for the user API",
  title: "User API tests",
  run_in_background: true,
});
```

### Research before action

```javascript
// Good: research in parallel before making a decision
mux.task({
  prompt: "How does the existing cache layer work?",
  title: "Cache research",
  run_in_background: true,
});
mux.task({
  prompt: "What caching patterns are used elsewhere in the codebase?",
  title: "Pattern research",
  run_in_background: true,
});
// Wait for results, then make an informed implementation decision
```

## Anti-patterns

- **Sequential when parallel is possible**: doing tasks one-by-one when they could run simultaneously
- **Over-scoped prompts**: giving a sub-agent too many unrelated tasks (split into focused prompts instead)
- **Foreground for long tasks**: blocking on exploratory work instead of backgrounding it
- **Re-doing sub-agent work**: repeating searches or analysis that a sub-agent already completed
