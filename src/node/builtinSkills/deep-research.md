---
name: deep-research
description: Run a multi-source, adversarially verified research workflow.
---

# Deep Research

Use this workflow when the user wants a deep, multi-source, fact-checked research report. Before invoking it, make sure the request is specific enough to research directly. If the prompt is underspecified, ask a few clarifying questions and pass the refined question as `input`.

Invoke with:

```js
workflow_run({
  script_path: "skill://deep-research/workflow.js",
  args: { input: "<refined research question>" },
});
```

The workflow scopes search angles, searches and fetches sources, extracts falsifiable claims, verifies claims adversarially, and synthesizes a cited report with caveats.
