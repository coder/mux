---
author: @ammario
date: 2026-02-23
---

# Workspace Default Runtime

Commit 88a2be88e2 moved the workspace default runtime config from a tooltip checkbox to a
dedicated sections page. It left the following outstanding UX gaps:

- Unclear path for user to set runtime config to default
- Unclear persistence behavior for runtime options


Two fixes are required:

- Make the `configure` runtime more prominent, and call it `set defaults` instead.
  - Create distinct visual style when the current runtime options are not the default so the user
  can more quickly see how they would persist their changes.
- Include runtime options in the new runtime settings page to clarify how the defaults work there.
    
There's also a bug where clicking the configure button on a project page takes you to the 
settings page with a global scope instead of the project scope. We should fix this as well.


## Code Structure

During this change, it is imperative that we have single-ownership of:

- What options are available per runtime
- The setting / getting of defaults
- The list of runtime types