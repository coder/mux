---
title: Prompting Tips
description: Tips and tricks for getting the most out of your AI agents
---

> Some tips and tricks from the mux developers on getting the most out of your agents.

## Persist lessons

When you notice agents make the same class of mistake repeatedly, ask them to modify their `AGENTS.md`
to prevent the mistake from happening again. We have found this pattern is most effective when:

- You specify the size of the change
  - LLMs love fluff — always specify a size constraint like "change at most two sentences"
- Ask the agent to focus on the general lesson, not the specific mistake

Codebases often have "watering hole" type files that are read in the course of
certain types of changes. For example, you may have a central file defining an API interface. When
the lesson is only relevant to a particular type of change it's often better to persist lessons as
source comments in such files vs. expanding the global `AGENTS.md`.

## Define the loop

Agents thrive on TDD. Try to define their task in terms of what checks need to pass before they
can claim success.

For mux development, we have a [`wait_pr_checks.sh`](https://github.com/coder/mux/blob/main/scripts/wait_pr_checks.sh) script
that polls GitHub and ensures that:

- There are no dirty changes
- All checks pass
- All review comments are resolved
- There are no merge conflicts

Create a similar script for your project and try asking your agent to work persistently until it
passes.

## Aggressively prune context

Even though Sonnet 4.5 has up to 1M in potential context, we experience a noticeable improvement in
quality when kept under 100k tokens. We suggest running `/compact` with a continue message
often to keep context small. For example:

```
/compact
<what you want next>
```

This will automatically send a follow-up message after compaction to keep the session flowing.

## Keeping code clean

Some prompts that help you keep the codebase clean:

Elevate the fix to design level:

- We keep seeing this class of bug in component X, fix this at a design level
- There's bug X, provide a fix that solves the whole class of bugs

At the end of a long session before compaction, try asking:

- How can the code/architecture be improved to make similar changes easier?
- What notes in AGENTS.md would make this change easier for future Assistants?

At end of long session (ideally after compaction), try asking:

- DRY your work
- Strive for net LoC reduction
- Review in depth, simplify
