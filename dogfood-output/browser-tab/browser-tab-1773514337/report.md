# Dogfood Report: Browser Tab in Right Sidebar

## Run Metadata

| Field | Value |
| --- | --- |
| Run ID | `browser-tab-1773514337` |
| Date | `2026-03-14T18:52:17+00:00` |
| Feature | Browser Tab in Right Sidebar |
| Commits tested | 6 commits on branch `agent-browser-r1as` |
| Environment | Mux dev-server sandbox (backend + Vite frontend) |
| Dogfood tool | `agent-browser` CLI driving the Mux frontend via headless browser |

## Executive Summary

The Browser tab feature was tested end-to-end through structured exploratory QA. The core flows all worked as intended: starting a session, rendering the live screenshot viewer, tracking navigation actions, updating page metadata, and preserving session state across right-sidebar tab switches.

Three issues were identified during the run:

- **1 minor cosmetic issue** affecting the idle-state button layout.
- **2 moderate UX/lifecycle gaps** affecting session control and closure detection.

None of the findings block the initial merge. The feature is functional and reviewable as an MVP, with the moderate issues documented for follow-up.

## Coverage Summary

### Covered flows

1. ✅ **Session start / tab surfacing**  
   The Browser tab appears in the right sidebar tab bar with a globe icon. Clicking **Start Session** launches an `agent-browser` subprocess, transitions the UI to **Live**, and records the initial navigation action.
2. ✅ **Watch-only navigation**  
   Navigation was exercised across `about:blank`, `example.com`, `httpbin.org/html`, and `httpbin.org/forms/post`. The Browser tab updated URL, title, screenshot, and timeline entries within the expected ~4 second polling window.
3. ✅ **Screenshot viewer**  
   Base64 JPEG screenshots rendered correctly in the viewer using an `object-contain` presentation. This was validated against simple pages, text-heavy pages, and form-heavy pages.
4. ✅ **Action timeline**  
   Navigate actions were shown in chronological order with page titles when available, relative timestamps such as “just now”, “1 minute ago”, and “3 minutes ago”, plus a correctly updating count badge.
5. ✅ **Tab switching**  
   Switching from Browser → Stats → Browser preserved the active session. A navigation that happened while the Browser tab was hidden was still captured and visible after returning.
6. ✅ **Empty / idle state**  
   The idle state rendered cleanly with the globe icon, descriptive copy, and **Start Session** button. No crashes or rendering corruption were observed.
7. ⚠️ **Session end detection**  
   Closing the browser externally via `agent-browser close` did **not** transition the UI to an ended state.
8. ⚠️ **Stop session UX**  
   There is currently no in-product control to stop a live browser session from the Browser tab.

## Detailed Findings

### ISSUE-001 — Minor: “Start Session” button text partially truncated

- **Severity:** Minor
- **Type:** Cosmetic / layout

**Reproduction steps**

1. Open a workspace.
2. Click the Browser tab.
3. Observe the header area in the default-width right sidebar.

**Expected**

The **Start Session** button text is fully visible.

**Actual**

The button label appears slightly clipped on the right edge when the sidebar is at its default width.

**Impact**

Low. The control remains usable, but the clipped label makes the idle state feel less polished.

**Evidence**

- `04-browser-tab-empty.png`
- `07-browser-tab-idle-clean.png`

**Video**

- N/A — visible on load as a static layout issue.

**Suspected root cause**

The header layout uses `shrink-0`, but the button can still visually overflow when the sidebar panel is narrow.

---

### ISSUE-002 — Moderate: No “Stop Session” button during live sessions

- **Severity:** Moderate
- **Type:** Missing UX affordance

**Reproduction steps**

1. Start a browser session from the Browser tab.
2. Wait for the session to transition to **Live**.
3. Look for a control to stop or end the session.

**Expected**

A **Stop Session** button or equivalent menu action is available while the session is live.

**Actual**

No stop/end control is rendered during a live session. The current `showStartButton` logic in `BrowserTab.tsx` only renders the button when `session == null`, `status === "ended"`, or `status === "error"`, leaving no visible way to stop a healthy live session.

**Impact**

Users cannot stop a session from the UI. In practice, the session only ends if the backend disposes it, the `agent-browser` subprocess dies, or the app shuts down.

**Evidence**

- Interactive snapshot during a live session showed no Stop/End control.

**Video**

- N/A

**Notes**

This is an MVP gap rather than a correctness failure, but it is noticeable because the session otherwise feels fully interactive.

---

### ISSUE-003 — Moderate: Session does not detect external browser closure

- **Severity:** Moderate
- **Type:** Lifecycle detection gap

**Reproduction steps**

1. Start a browser session from the Mux UI.
2. Navigate to several pages and confirm normal Browser tab updates.
3. Run `agent-browser --session <name> close` externally.
4. Wait at least 10 seconds to allow multiple poll cycles.

**Expected**

The Browser tab detects the closure and transitions to an **ended** or **error** state, ideally surfacing a restart action.

**Actual**

The UI remains in **Live** state and switches to `about:blank · User owned`. A new timeline entry is recorded for the `about:blank` navigation, and the session never transitions to **ended**.

**Impact**

The Browser tab gives the impression that the session is still healthy even after the externally controlled browser window has been closed. This can confuse users and obscures the real lifecycle state.

**Evidence**

- `16-session-ended.png`
- `17-after-long-wait.png`

**Video**

- N/A

**Root cause**

`agent-browser close` shuts down Chromium, but the `agent-browser` daemon process remains alive. Backend polling continues to succeed because the daemon responds with fresh `about:blank` state and a screenshot, so the backend cannot currently distinguish between “browser actively in use” and “daemon alive with an auto-opened blank page.”

## Evidence Inventory

### Screenshots

20 screenshots were captured during the run (~1 MB total). Key evidence files referenced in this report are listed below.

| # | File | Description |
| --- | --- | --- |
| 01 | `01-initial-load.png` | Mux home page after initial load |
| 02 | `02-workspace-view.png` | Workspace view with tutorial popover; Browser tab visible in tab bar |
| 03 | `03-browser-tab-idle.png` | Browser tab idle state while server was reconnecting |
| 04 | `04-browser-tab-empty.png` | Browser tab empty state with globe icon, “No browser session”, and visible ISSUE-001 clipping |
| 07 | `07-browser-tab-idle-clean.png` | Clean idle state after server reconnection |
| 10 | `10-after-start-click.png` | Live session started with Live badge, `about:blank · User owned`, and initial Navigate action |
| 12 | `12-live-example-com.png` | Example Domain rendered in viewer with 2 tracked actions |
| 13 | `13-live-httpbin.png` | `httpbin.org/html` rendered with Moby-Dick excerpt and 3 tracked actions |
| 15 | `15-back-to-browser-form.png` | `httpbin.org/forms/post` visible after tab switch; navigation while hidden was preserved |
| 16 | `16-session-ended.png` | Persistent Live state after external close; `about:blank` shown |
| 17 | `17-after-long-wait.png` | Still Live after additional wait, confirming ISSUE-003 |

### Videos

| # | File | Description |
| --- | --- | --- |
| 01 | `01-live-browser-tab.webm` | Short recording showing live Browser tab updates during navigation |

## Acceptance Criteria Check

| Criteria | Result | Notes |
| --- | --- | --- |
| Browser tab appears in the right sidebar | ✅ Pass | Globe icon present and tab is selectable |
| Live browser session can be viewed | ✅ Pass | Session enters Live state after start |
| Screenshot viewer shows real-time page content | ✅ Pass | Viewer updated across multiple pages |
| Action timeline tracks navigations with titles and timestamps | ✅ Pass | Ordering, labels, and counts were correct |
| Session survives tab switching | ✅ Pass | Navigation while hidden was captured |
| Background polling continues when tab is hidden | ✅ Pass | Confirmed through post-switch action history |
| Empty / idle state renders correctly | ✅ Pass | Stable empty state with no crashes |
| Session detects external browser closure | ❌ Fail | See ISSUE-003 |
| User can stop a session from the UI | ❌ Fail | See ISSUE-002 |

## Verdict

- **Blocking issues:** 0
- **Moderate issues:** 2
  - ISSUE-002 — missing Stop Session control
  - ISSUE-003 — external browser closure is not detected
- **Minor issues:** 1
  - ISSUE-001 — Start Session label clipping

**Overall assessment:** The Browser tab feature is working well for its primary MVP goals. Session startup, live screenshot viewing, navigation tracking, timeline rendering, and resilience across sidebar tab switches all behaved correctly during dogfooding. The two moderate issues are real and worth follow-up, but they do not block an initial merge given the strength of the core flow.

## Recommended Follow-up

1. Add an in-UI **Stop Session** affordance for live sessions.
2. Tighten lifecycle detection so externally closed sessions transition to **ended** or **error** instead of silently falling back to `about:blank`.
3. Adjust the idle-state header layout so the **Start Session** label does not clip at narrow sidebar widths.
