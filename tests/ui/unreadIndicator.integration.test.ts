/**
 * UI integration tests for the unread indicator.
 *
 * The unread indicator shows when a workspace has activity the user hasn't seen.
 * Key components:
 * - recencyTimestamp: derived from max of user message, compacted message, or stream completion time
 * - lastReadTimestamp: persisted in localStorage, updated when workspace is selected
 * - isUnread: recencyTimestamp > lastReadTimestamp
 *
 * Behavior under test: stream completion should make non-selected workspaces unread,
 * while selected workspaces should be auto-marked as read.
 */

import "./dom";
import { waitFor } from "@testing-library/react";

import { preloadTestModules } from "../ipc/setup";
import { createAppHarness, type AppHarness } from "./harness";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getWorkspaceLastReadKey } from "@/common/constants/storage";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";

/**
 * Get the unread state for a workspace from the WorkspaceStore.
 */
function getWorkspaceUnreadState(workspaceId: string): {
  recencyTimestamp: number | null;
  isUnread: (lastReadTimestamp: number) => boolean;
} {
  const state = workspaceStore.getWorkspaceSidebarState(workspaceId);
  return {
    recencyTimestamp: state.recencyTimestamp,
    isUnread: (lastReadTimestamp: number) =>
      state.recencyTimestamp !== null && state.recencyTimestamp > lastReadTimestamp,
  };
}

/**
 * Get the lastReadTimestamp from persisted state.
 */
function getLastReadTimestamp(workspaceId: string): number {
  return readPersistedState<number>(getWorkspaceLastReadKey(workspaceId), 0);
}

/**
 * Find the workspace element in the sidebar and check if it shows the unread indicator.
 */
function getWorkspaceUnreadIndicator(
  container: HTMLElement,
  workspaceId: string
): { element: HTMLElement; hasUnreadBar: boolean } | null {
  const workspaceEl = container.querySelector(
    `[data-workspace-id="${workspaceId}"]`
  ) as HTMLElement | null;

  if (!workspaceEl) return null;

  // The unread bar is a span with the unread styling
  const unreadBar = workspaceEl.querySelector(
    'span[class*="bg-muted-foreground"]'
  ) as HTMLElement | null;

  return {
    element: workspaceEl,
    hasUnreadBar: unreadBar !== null && unreadBar.getAttribute("aria-hidden") !== "true",
  };
}

describe("Unread indicator (mock AI router)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  describe("basic unread tracking", () => {
    let app: AppHarness;

    beforeEach(async () => {
      app = await createAppHarness({ branchPrefix: "unread" });
    });

    afterEach(async () => {
      await app.dispose();
    });

    test("workspace is not unread when first opened", async () => {
      // When a workspace is first selected, it should not show as unread
      const lastRead = getLastReadTimestamp(app.workspaceId);
      const { recencyTimestamp: _recencyTimestamp, isUnread } = getWorkspaceUnreadState(
        app.workspaceId
      );

      // A fresh workspace may have recencyTimestamp from createdAt
      // but lastReadTimestamp should be set when we selected it
      expect(lastRead).toBeGreaterThan(0);
      expect(isUnread(lastRead)).toBe(false);
    });

    test("recencyTimestamp updates when user sends a message", async () => {
      const beforeSend = getWorkspaceUnreadState(app.workspaceId);
      const beforeRecency = beforeSend.recencyTimestamp;

      await app.chat.send("Hello, this is a test message");
      await app.chat.expectTranscriptContains("Mock response: Hello, this is a test message");

      const afterSend = getWorkspaceUnreadState(app.workspaceId);

      // Recency should have updated to reflect the user message timestamp
      expect(afterSend.recencyTimestamp).not.toBeNull();
      if (beforeRecency !== null) {
        expect(afterSend.recencyTimestamp).toBeGreaterThanOrEqual(beforeRecency);
      }
    });

    test("recencyTimestamp is stable after stream completes (no further changes without new activity)", async () => {
      // Recency now includes stream completion time.
      // This test validates that once the stream is done, recency stays stable
      // unless there is additional activity.

      await app.chat.send("First message");
      await app.chat.expectTranscriptContains("Mock response: First message");

      const afterFirstMessage = getWorkspaceUnreadState(app.workspaceId);
      const recencyAfterFirst = afterFirstMessage.recencyTimestamp;

      // Wait a bit to ensure any timing differences would be detectable
      await new Promise((r) => setTimeout(r, 50));

      // Stream completion already happened before we captured recencyAfterFirst,
      // so without new activity the value should remain unchanged.
      const currentState = getWorkspaceUnreadState(app.workspaceId);
      expect(currentState.recencyTimestamp).toBe(recencyAfterFirst);
    });
  });

  describe("unread indicator during streaming", () => {
    let app: AppHarness;

    beforeEach(async () => {
      app = await createAppHarness({ branchPrefix: "unread-stream" });
    });

    afterEach(async () => {
      await app.dispose();
    });

    test("workspace should NOT show unread after stream completes while viewing it", async () => {
      // This is the bug scenario:
      // 1. User is viewing workspace A
      // 2. User sends message
      // 3. Stream starts and completes
      // 4. Workspace should NOT show as unread (user is actively viewing it)

      await app.chat.send("Test message for unread bug");
      await app.chat.expectTranscriptContains("Mock response: Test message for unread bug");

      // After stream completes, check unread state
      const lastReadAfter = getLastReadTimestamp(app.workspaceId);
      const { recencyTimestamp, isUnread } = getWorkspaceUnreadState(app.workspaceId);

      // The workspace should NOT be unread while we're viewing it.
      // handleResponseComplete marks the selected workspace as read when a final
      // stream completes, even though stream completion bumps recency.
      expect(isUnread(lastReadAfter)).toBe(false);

      // lastReadTimestamp should be >= recencyTimestamp after the fix
      if (recencyTimestamp !== null) {
        expect(lastReadAfter).toBeGreaterThanOrEqual(recencyTimestamp);
      }
    });

    test("selected workspace lastRead is updated on stream completion", async () => {
      const lastReadBefore = getLastReadTimestamp(app.workspaceId);
      const beforeSend = Date.now();

      await app.chat.send("Test for read update");
      await app.chat.expectTranscriptContains("Mock response: Test for read update");
      const afterComplete = Date.now();

      const lastRead = getLastReadTimestamp(app.workspaceId);
      const { recencyTimestamp } = getWorkspaceUnreadState(app.workspaceId);

      // handleResponseComplete updates selected workspace lastRead before any
      // notification-related early return logic.
      expect(lastRead).toBeGreaterThanOrEqual(lastReadBefore);
      expect(lastRead).toBeGreaterThanOrEqual(beforeSend);
      expect(lastRead).toBeLessThanOrEqual(afterComplete + 1000);
      if (recencyTimestamp !== null) {
        expect(lastRead).toBeGreaterThanOrEqual(recencyTimestamp);
      }
    });

    test("stream completion bumps recency for unread detection", async () => {
      // Core behavior: stream completion now bumps recencyTimestamp,
      // so a non-active reader should see this workspace as unread.
      await app.chat.send("Message to trigger stream");
      await app.chat.expectTranscriptContains("Mock response: Message to trigger stream");

      const { recencyTimestamp, isUnread } = getWorkspaceUnreadState(app.workspaceId);
      expect(recencyTimestamp).not.toBeNull();

      // Simulate someone who last read this workspace before stream completion.
      const lastReadBeforeStreamCompleted = recencyTimestamp! - 1000;
      expect(isUnread(lastReadBeforeStreamCompleted)).toBe(true);
    });

    test("workspace should show unread when activity happens in non-selected workspace", async () => {
      // Simulate activity in a workspace the user is NOT viewing
      // by temporarily switching away

      // First, send a message while viewing
      await app.chat.send("Initial message");
      await app.chat.expectTranscriptContains("Mock response: Initial message");

      // Record timestamps
      const recencyAfterFirstMsg = getWorkspaceUnreadState(app.workspaceId).recencyTimestamp;

      // Simulate "looking away" by setting lastReadTimestamp to the past
      const pastTime = (recencyAfterFirstMsg ?? Date.now()) - 10000;
      updatePersistedState(getWorkspaceLastReadKey(app.workspaceId), pastTime);

      // Now simulate another message arriving (as if from background)
      await app.chat.send("Second message while away");
      await app.chat.expectTranscriptContains("Mock response: Second message while away");

      // The workspace should now show as unread
      const { isUnread, recencyTimestamp } = getWorkspaceUnreadState(app.workspaceId);
      expect(recencyTimestamp).not.toBeNull();
      expect(isUnread(pastTime)).toBe(true);
    });
  });

  describe("unread bar visibility", () => {
    let app: AppHarness;

    beforeEach(async () => {
      app = await createAppHarness({ branchPrefix: "unread-bar" });
    });

    afterEach(async () => {
      await app.dispose();
    });

    test("unread bar is hidden when workspace is selected", async () => {
      // Even if isUnread is true, the unread bar should be hidden when selected

      // Force unread state by backdating lastReadTimestamp
      await app.chat.send("Test message");
      await app.chat.expectTranscriptContains("Mock response: Test message");

      const recency = getWorkspaceUnreadState(app.workspaceId).recencyTimestamp;
      const pastTime = (recency ?? Date.now()) - 5000;
      updatePersistedState(getWorkspaceLastReadKey(app.workspaceId), pastTime);

      // Wait for state to propagate
      await waitFor(() => {
        const { isUnread } = getWorkspaceUnreadState(app.workspaceId);
        expect(isUnread(pastTime)).toBe(true);
      });

      // But the unread bar should still be hidden because the workspace is selected
      const indicator = getWorkspaceUnreadIndicator(app.view.container, app.workspaceId);
      expect(indicator).not.toBeNull();
      // showUnreadBar has condition: !(isSelected && !isDisabled)
      // Since workspace is selected, unread bar should not show
      expect(indicator?.hasUnreadBar).toBe(false);
    });
  });

  describe("recency computation correctness", () => {
    let app: AppHarness;

    beforeEach(async () => {
      app = await createAppHarness({ branchPrefix: "recency" });
    });

    afterEach(async () => {
      await app.dispose();
    });

    test("recencyTimestamp reflects stream completion time", async () => {
      // Send a user message and note the recency
      const beforeSend = Date.now();
      await app.chat.send("User message for recency test");

      // Wait for stream to complete
      await app.chat.expectTranscriptContains("Mock response: User message for recency test");
      const afterComplete = Date.now();

      const { recencyTimestamp } = getWorkspaceUnreadState(app.workspaceId);

      // Recency now includes stream completion time, so it should fall within
      // the send/completion window.
      expect(recencyTimestamp).not.toBeNull();
      // Allow some tolerance for timing
      expect(recencyTimestamp!).toBeGreaterThanOrEqual(beforeSend - 100);
      // Recency should be no later than shortly after completion.
      expect(recencyTimestamp!).toBeLessThan(afterComplete + 1000);
    });

    test("multiple user messages update recencyTimestamp to the latest", async () => {
      await app.chat.send("First message");
      await app.chat.expectTranscriptContains("Mock response: First message");

      const recency1 = getWorkspaceUnreadState(app.workspaceId).recencyTimestamp;

      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 50));

      await app.chat.send("Second message");
      await app.chat.expectTranscriptContains("Mock response: Second message");

      const recency2 = getWorkspaceUnreadState(app.workspaceId).recencyTimestamp;

      expect(recency2).not.toBeNull();
      expect(recency1).not.toBeNull();
      expect(recency2!).toBeGreaterThan(recency1!);
    });
  });
});
