import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import type { Result } from "@/common/types/result";
import { TitleEditProvider, useTitleEdit } from "./WorkspaceTitleEditContext";

interface ContextProbeProps {
  onValue: (value: ReturnType<typeof useTitleEdit>) => void;
}

function ContextProbe(props: ContextProbeProps): null {
  const value = useTitleEdit();
  props.onValue(value);
  return null;
}

type RegenerateTitleResult = Result<{ title: string }, string>;

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return {
    promise,
    resolve: (value: T) => resolve?.(value),
  };
}

function isGeneratingTitle(
  value: ReturnType<typeof useTitleEdit> | null,
  workspaceId: string
): boolean {
  if (!value) {
    return false;
  }
  return [...value.generatingTitleWorkspaceIds].includes(workspaceId);
}

describe("WorkspaceTitleEditContext", () => {
  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
    globalThis.localStorage = undefined as unknown as Storage;
  });

  test("ignores duplicate regenerate requests while one is already in flight", async () => {
    const testWindow = new GlobalWindow();
    globalThis.window = testWindow as unknown as Window & typeof globalThis;
    globalThis.document = testWindow.document as unknown as Document;
    globalThis.localStorage = testWindow.localStorage as unknown as Storage;

    let contextValue: ReturnType<typeof useTitleEdit> | null = null;

    render(
      <TitleEditProvider onUpdateTitle={() => Promise.resolve({ success: true })}>
        <ContextProbe onValue={(value) => (contextValue = value)} />
      </TitleEditProvider>
    );

    await waitFor(() => expect(contextValue).not.toBeNull());

    const deferred = createDeferred<RegenerateTitleResult>();
    const regenerate = mock(() => deferred.promise);

    act(() => {
      contextValue?.wrapGenerateTitle("ws-1", regenerate);
      contextValue?.wrapGenerateTitle("ws-1", regenerate);
    });

    expect(regenerate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(isGeneratingTitle(contextValue, "ws-1")).toBe(true));

    act(() => {
      deferred.resolve({ success: true, data: { title: "Regenerated" } });
    });

    await waitFor(() => expect(contextValue?.generatingTitleWorkspaceIds.size).toBe(0));

    const completedResult: RegenerateTitleResult = {
      success: true,
      data: { title: "Regenerated again" },
    };
    const regenerateAfterComplete = mock(() => Promise.resolve(completedResult));

    act(() => {
      contextValue?.wrapGenerateTitle("ws-1", regenerateAfterComplete);
    });

    expect(regenerateAfterComplete).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(contextValue?.generatingTitleWorkspaceIds.size).toBe(0));
  });

  test("keeps loading state for other workspaces when one regeneration finishes", async () => {
    const testWindow = new GlobalWindow();
    globalThis.window = testWindow as unknown as Window & typeof globalThis;
    globalThis.document = testWindow.document as unknown as Document;
    globalThis.localStorage = testWindow.localStorage as unknown as Storage;

    let contextValue: ReturnType<typeof useTitleEdit> | null = null;

    render(
      <TitleEditProvider onUpdateTitle={() => Promise.resolve({ success: true })}>
        <ContextProbe onValue={(value) => (contextValue = value)} />
      </TitleEditProvider>
    );

    await waitFor(() => expect(contextValue).not.toBeNull());

    const deferredA = createDeferred<RegenerateTitleResult>();
    const deferredB = createDeferred<RegenerateTitleResult>();
    const regenerateA = mock(() => deferredA.promise);
    const regenerateB = mock(() => deferredB.promise);

    act(() => {
      contextValue?.wrapGenerateTitle("ws-a", regenerateA);
      contextValue?.wrapGenerateTitle("ws-b", regenerateB);
    });

    await waitFor(() => expect(isGeneratingTitle(contextValue, "ws-a")).toBe(true));
    await waitFor(() => expect(isGeneratingTitle(contextValue, "ws-b")).toBe(true));

    act(() => {
      deferredB.resolve({ success: true, data: { title: "B" } });
    });

    await waitFor(() => expect(isGeneratingTitle(contextValue, "ws-b")).toBe(false));
    expect(isGeneratingTitle(contextValue, "ws-a")).toBe(true);

    act(() => {
      contextValue?.wrapGenerateTitle("ws-a", regenerateA);
    });
    expect(regenerateA).toHaveBeenCalledTimes(1);

    act(() => {
      deferredA.resolve({ success: true, data: { title: "A" } });
    });

    await waitFor(() => expect(contextValue?.generatingTitleWorkspaceIds.size).toBe(0));
  });
});
