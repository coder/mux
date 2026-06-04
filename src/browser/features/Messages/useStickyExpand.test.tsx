import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type React from "react";
import { installDom } from "../../../../tests/ui/dom";

import { getAutoExpandPrefsKey } from "@/common/constants/storage";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";

import { MessageListProvider } from "./MessageListContext";
import { useStickyExpand, type AutoExpandPrefs } from "./useStickyExpand";

function makeWrapper(workspaceId: string | null) {
  return function Wrapper(props: { children: React.ReactNode }) {
    if (workspaceId == null) {
      return <>{props.children}</>;
    }
    return (
      <MessageListProvider value={{ workspaceId, latestMessageId: null }}>
        {props.children}
      </MessageListProvider>
    );
  };
}

function readPrefs(workspaceId: string): AutoExpandPrefs {
  return readPersistedState<AutoExpandPrefs>(getAutoExpandPrefsKey(workspaceId), {});
}

describe("useStickyExpand", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("seeds from the fallback when no preference is stored", () => {
    const collapsed = renderHook(() => useStickyExpand("tools", false), {
      wrapper: makeWrapper("ws-1"),
    });
    expect(collapsed.result.current.expanded).toBe(false);

    const expanded = renderHook(() => useStickyExpand("thinking", true), {
      wrapper: makeWrapper("ws-1"),
    });
    expect(expanded.result.current.expanded).toBe(true);
  });

  test("a stored preference wins over the fallback at mount", () => {
    updatePersistedState<AutoExpandPrefs>(getAutoExpandPrefsKey("ws-1"), { tools: true });
    const overridden = renderHook(() => useStickyExpand("tools", false), {
      wrapper: makeWrapper("ws-1"),
    });
    expect(overridden.result.current.expanded).toBe(true);

    updatePersistedState<AutoExpandPrefs>(getAutoExpandPrefsKey("ws-1"), {
      tools: true,
      thinking: false,
    });
    const collapsed = renderHook(() => useStickyExpand("thinking", true), {
      wrapper: makeWrapper("ws-1"),
    });
    expect(collapsed.result.current.expanded).toBe(false);
  });

  test("a toggle writes only its own kind to the workspace preference", () => {
    const { result } = renderHook(() => useStickyExpand("thinking", false), {
      wrapper: makeWrapper("ws-1"),
    });

    act(() => result.current.toggleExpanded());

    expect(result.current.expanded).toBe(true);
    // Only the toggled kind is persisted; the sibling kind is untouched.
    expect(readPrefs("ws-1")).toEqual({ thinking: true });
  });

  test("a preference change never mutates an already-mounted block, but new blocks inherit it", () => {
    // Mount block A with the quiet (collapsed) fallback.
    const blockA = renderHook(() => useStickyExpand("tools", false), {
      wrapper: makeWrapper("ws-1"),
    });
    expect(blockA.result.current.expanded).toBe(false);

    // Simulate another block (or a sibling component) flipping the workspace
    // preference to expanded. The present block must NOT react — no layout flash.
    act(() => {
      updatePersistedState<AutoExpandPrefs>(getAutoExpandPrefsKey("ws-1"), { tools: true });
    });
    expect(blockA.result.current.expanded).toBe(false);

    // A freshly mounted block inherits the new preference.
    const blockB = renderHook(() => useStickyExpand("tools", false), {
      wrapper: makeWrapper("ws-1"),
    });
    expect(blockB.result.current.expanded).toBe(true);
  });

  test("preferences are scoped per workspace", () => {
    updatePersistedState<AutoExpandPrefs>(getAutoExpandPrefsKey("ws-1"), { tools: true });

    const otherWorkspace = renderHook(() => useStickyExpand("tools", false), {
      wrapper: makeWrapper("ws-2"),
    });
    expect(otherWorkspace.result.current.expanded).toBe(false);
    expect(readPrefs("ws-2")).toEqual({});
  });

  test("opens on a late forceExpanded trigger and never auto-collapses it (latched)", () => {
    // Mirrors a task / task_await row whose error or failed-sub-task signal only
    // becomes known after mount (Codex P2). Seeding once would miss it.
    const { result, rerender } = renderHook(
      ({ force }: { force: boolean }) => useStickyExpand("tools", false, { forceExpanded: force }),
      { wrapper: makeWrapper("ws-1"), initialProps: { force: false } }
    );
    expect(result.current.expanded).toBe(false);

    // Error arrives → row opens.
    rerender({ force: true });
    expect(result.current.expanded).toBe(true);

    // Trigger clears → row stays open (no collapse tear) and nothing is persisted.
    rerender({ force: false });
    expect(result.current.expanded).toBe(true);
    expect(readPrefs("ws-1")).toEqual({});
  });

  test("a user collapse still wins over an active forceExpanded signal", () => {
    const { result } = renderHook(() => useStickyExpand("tools", false, { forceExpanded: true }), {
      wrapper: makeWrapper("ws-1"),
    });
    expect(result.current.expanded).toBe(true);

    act(() => result.current.setExpanded(false));

    expect(result.current.expanded).toBe(false);
    expect(readPrefs("ws-1")).toEqual({ tools: false });
  });

  test("forceExpanded overrides a collapsed stored preference and does not persist", () => {
    updatePersistedState<AutoExpandPrefs>(getAutoExpandPrefsKey("ws-1"), { tools: false });

    const { result } = renderHook(() => useStickyExpand("tools", false, { forceExpanded: true }), {
      wrapper: makeWrapper("ws-1"),
    });

    expect(result.current.expanded).toBe(true);
    // Seeding from forceExpanded must not rewrite the stored preference.
    expect(readPrefs("ws-1")).toEqual({ tools: false });
  });

  test("degrades to local-only state with no persistence outside a workspace context", () => {
    const { result } = renderHook(() => useStickyExpand("tools", false));
    expect(result.current.expanded).toBe(false);

    act(() => result.current.toggleExpanded());

    expect(result.current.expanded).toBe(true);
    // No workspaceId → nothing is written to storage.
    expect(globalThis.localStorage.length).toBe(0);
  });
});
