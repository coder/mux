---
name: workflow-smoke
description: Minimal built-in workflow fixture for validating skill-packaged workflow execution.
advertise: false
---

# Workflow Smoke

This hidden skill exists to dogfood and test built-in `skill://` workflow packaging.

Invoke with:

```js
workflow_run({
  script_path: "skill://workflow-smoke/workflow.js",
  args: { message: "hello" },
});
```
