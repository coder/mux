---
name: spawn
description: Delegate the whole task to a single sub-agent to preserve the parent's context window
advertise: false
---

# Spawn

When the user invokes `/spawn`, complete the entire task by spawning one sub-agent with a self-contained brief instead of doing the work yourself. This keeps your context window spent on coordination rather than on the file reads, searches, and tool output the work would otherwise accumulate. Wait for the sub-agent, then integrate and report its result.
