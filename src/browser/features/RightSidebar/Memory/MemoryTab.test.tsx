// Bootstrap Happy DOM before react-dom evaluates: React decides input-event
// support at module-eval time, and controlled <textarea> onChange never fires
// if `document` was undefined when react-dom loaded.
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createContext, type ReactNode } from "react";
import { installDom } from "../../../../../tests/ui/dom";
import type { MemoryFileInfo } from "@/common/orpc/schemas/memory";

interface MemoryChangeEvent {
  scope: "global" | "project" | "workspace";
  path: string;
  actor: "agent" | "user";
  workspaceId: string;
  projectPath: string;
}

/**
 * Minimal fake of the api.memory surface the tab consumes. Tests drive change
 * events through `emitChange` to exercise the live-refresh path.
 */
function createFakeMemoryApi(initialFiles: MemoryFileInfo[]) {
  const state = {
    files: initialFiles,
    contents: new Map<string, { content: string; sha256: string }>(),
    saveCalls: [] as Array<{ path: string; content: string; expectedSha256: string | null }>,
    deleteCalls: [] as string[],
    pinCalls: [] as Array<{ path: string; pinned: boolean }>,
    nextSaveConflict: false,
    listeners: new Set<(event: MemoryChangeEvent) => void>(),
  };

  const api = {
    memory: {
      list: (_input: { workspaceId: string }, _opts?: { signal?: AbortSignal }) =>
        Promise.resolve({ success: true as const, data: { files: state.files } }),
      read: (input: { workspaceId: string; path: string }, _opts?: { signal?: AbortSignal }) => {
        const entry = state.contents.get(input.path);
        return Promise.resolve(
          entry
            ? { success: true as const, data: entry }
            : { success: false as const, error: `No memory file at ${input.path}` }
        );
      },
      save: (input: {
        workspaceId: string;
        path: string;
        content: string;
        expectedSha256: string | null;
      }) => {
        state.saveCalls.push({
          path: input.path,
          content: input.content,
          expectedSha256: input.expectedSha256,
        });
        if (state.nextSaveConflict) {
          state.nextSaveConflict = false;
          return Promise.resolve({
            success: false as const,
            error: {
              kind: "conflict" as const,
              message: `${input.path} changed since it was loaded; reload and re-apply your edits`,
            },
          });
        }
        state.contents.set(input.path, { content: input.content, sha256: `sha-${input.content}` });
        return Promise.resolve({
          success: true as const,
          data: { sha256: `sha-${input.content}` },
        });
      },
      delete: (input: { workspaceId: string; path: string }) => {
        state.deleteCalls.push(input.path);
        state.files = state.files.filter((file) => file.path !== input.path);
        return Promise.resolve({ success: true as const, data: undefined });
      },
      setPinned: (input: { workspaceId: string; path: string; pinned: boolean }) => {
        state.pinCalls.push({ path: input.path, pinned: input.pinned });
        state.files = state.files.map((file) =>
          file.path === input.path ? { ...file, pinned: input.pinned } : file
        );
        return Promise.resolve({ success: true as const, data: undefined });
      },
      onChange: (_input: { workspaceId: string }, opts?: { signal?: AbortSignal }) => {
        async function* iterate(): AsyncGenerator<MemoryChangeEvent> {
          const queue: MemoryChangeEvent[] = [];
          let resolveNext: ((event: MemoryChangeEvent) => void) | null = null;
          const listener = (event: MemoryChangeEvent) => {
            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve(event);
            } else {
              queue.push(event);
            }
          };
          state.listeners.add(listener);
          try {
            while (!opts?.signal?.aborted) {
              if (queue.length > 0) {
                yield queue.shift()!;
                continue;
              }
              yield await new Promise<MemoryChangeEvent>((resolve) => {
                resolveNext = resolve;
              });
            }
          } finally {
            state.listeners.delete(listener);
          }
        }
        return Promise.resolve(iterate());
      },
    },
  };

  return {
    api,
    state,
    setContent(path: string, content: string, sha256: string) {
      state.contents.set(path, { content, sha256 });
    },
    emitChange(event: MemoryChangeEvent) {
      for (const listener of state.listeners) {
        listener(event);
      }
    },
  };
}

let fake: ReturnType<typeof createFakeMemoryApi> | null = null;

void mock.module("@/browser/contexts/API", () => ({
  APIContext: createContext(null),
  useAPI: () => ({
    api: fake?.api ?? null,
    status: fake ? "connected" : "error",
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

// The delete flow confirms through ConfirmationModal, which renders via a
// Radix Dialog portal that happy-dom cannot see. Mock the Dialog primitives
// to render inline so the real confirm/cancel behavior stays under test.
void mock.module("@/browser/components/Dialog/Dialog", () => ({
  Dialog: (props: { open: boolean; children?: unknown }) =>
    props.open ? <div>{props.children as ReactNode}</div> : null,
  DialogContent: (props: { children?: unknown }) => <div>{props.children as ReactNode}</div>,
  DialogHeader: (props: { children?: unknown }) => <div>{props.children as ReactNode}</div>,
  DialogTitle: (props: { children?: unknown }) => <h2>{props.children as ReactNode}</h2>,
  DialogDescription: (props: { children?: unknown }) => <p>{props.children as ReactNode}</p>,
  DialogFooter: (props: { children?: unknown }) => <div>{props.children as ReactNode}</div>,
  WarningBox: (props: { children?: unknown }) => <div>{props.children as ReactNode}</div>,
  WarningTitle: (props: { children?: unknown }) => <div>{props.children as ReactNode}</div>,
  WarningText: (props: { children?: unknown }) => <div>{props.children as ReactNode}</div>,
}));

import { MemoryTab } from "./MemoryTab";

function fileInfo(overrides: Partial<MemoryFileInfo> = {}): MemoryFileInfo {
  return {
    path: "/memories/global/prefs.md",
    scope: "global",
    description: "",
    pinned: false,
    accessCount: 0,
    lastAccessedAt: null,
    ...overrides,
  };
}

describe("MemoryTab", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
    fake = null;
  });

  test("lists files grouped by scope with descriptions", async () => {
    fake = createFakeMemoryApi([
      fileInfo({ path: "/memories/global/prefs.md", scope: "global", description: "likes tea" }),
      fileInfo({ path: "/memories/project/conventions.md", scope: "project" }),
    ]);
    const { getByText, findByText } = render(<MemoryTab workspaceId="ws-1" />);

    await findByText("prefs.md");
    expect(getByText("Global")).toBeTruthy();
    expect(getByText("Project")).toBeTruthy();
    expect(getByText("likes tea")).toBeTruthy();
    expect(getByText("conventions.md")).toBeTruthy();
  });

  test("shows an empty state when there are no memory files", async () => {
    fake = createFakeMemoryApi([]);
    const { findByText } = render(<MemoryTab workspaceId="ws-1" />);
    await findByText(/No memory files/);
  });

  test("shows usage stats for used files and omits them for never-used files", async () => {
    fake = createFakeMemoryApi([
      fileInfo({
        path: "/memories/global/hot.md",
        accessCount: 3,
        lastAccessedAt: Date.now(),
      }),
      fileInfo({ path: "/memories/global/cold.md" }),
    ]);
    const { findByText, queryAllByText } = render(<MemoryTab workspaceId="ws-1" />);

    await findByText("hot.md");
    await findByText(/Used 3×/);
    // The never-used file renders no usage line.
    expect(queryAllByText(/Used /)).toHaveLength(1);
  });

  test("pin toggle calls setPinned with the opposite state", async () => {
    fake = createFakeMemoryApi([fileInfo({ path: "/memories/global/prefs.md", pinned: false })]);
    const { findByLabelText } = render(<MemoryTab workspaceId="ws-1" />);

    fireEvent.click(await findByLabelText("Pin prefs.md"));
    await waitFor(() => {
      expect(fake!.state.pinCalls).toEqual([{ path: "/memories/global/prefs.md", pinned: true }]);
    });
    // After refresh the row reflects the pinned state.
    await findByLabelText("Unpin prefs.md");
  });

  test("opens a file, edits it, and saves with the loaded sha", async () => {
    fake = createFakeMemoryApi([fileInfo({ path: "/memories/global/prefs.md" })]);
    fake.setContent("/memories/global/prefs.md", "likes tea", "sha-original");
    const { findByText, findByLabelText } = render(<MemoryTab workspaceId="ws-1" />);

    fireEvent.click(await findByText("prefs.md"));
    const editor = (await findByLabelText("Memory file content")) as HTMLTextAreaElement;
    expect(editor.value).toBe("likes tea");

    fireEvent.input(editor, { target: { value: "likes coffee" } });
    fireEvent.click(await findByLabelText("Save memory file"));

    await waitFor(() => {
      expect(fake!.state.saveCalls).toEqual([
        {
          path: "/memories/global/prefs.md",
          content: "likes coffee",
          expectedSha256: "sha-original",
        },
      ]);
    });
  });

  test("shows a conflict banner when a save is rejected and reloads on request", async () => {
    fake = createFakeMemoryApi([fileInfo({ path: "/memories/global/prefs.md" })]);
    fake.setContent("/memories/global/prefs.md", "likes tea", "sha-original");
    const { findByText, findByLabelText } = render(<MemoryTab workspaceId="ws-1" />);

    fireEvent.click(await findByText("prefs.md"));
    const editor = (await findByLabelText("Memory file content")) as HTMLTextAreaElement;
    fireEvent.input(editor, { target: { value: "draft edit" } });

    fake.state.nextSaveConflict = true;
    fireEvent.click(await findByLabelText("Save memory file"));
    await findByText(/changed since it was loaded/);

    // Reload fetches the latest content and clears the conflict.
    fake.setContent("/memories/global/prefs.md", "agent version", "sha-agent");
    fireEvent.click(await findByLabelText("Reload memory file"));
    await waitFor(() => {
      expect(editor.value).toBe("agent version");
    });
  });

  test("deletes a file from the list after confirming the modal", async () => {
    fake = createFakeMemoryApi([fileInfo({ path: "/memories/global/prefs.md" })]);
    const { findByLabelText, findByText, findByRole } = render(<MemoryTab workspaceId="ws-1" />);

    fireEvent.click(await findByLabelText("Delete prefs.md"));
    // The row action only opens the confirmation modal; nothing is deleted yet.
    expect(fake.state.deleteCalls).toEqual([]);

    fireEvent.click(await findByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(fake!.state.deleteCalls).toEqual(["/memories/global/prefs.md"]);
    });
    await findByText(/No memory files/);
  });

  test("cancelling the delete confirmation keeps the file", async () => {
    fake = createFakeMemoryApi([fileInfo({ path: "/memories/global/prefs.md" })]);
    const { findByLabelText, findByText, findByRole, queryByRole } = render(
      <MemoryTab workspaceId="ws-1" />
    );

    fireEvent.click(await findByLabelText("Delete prefs.md"));
    fireEvent.click(await findByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(queryByRole("button", { name: "Cancel" })).toBeNull();
    });
    expect(fake.state.deleteCalls).toEqual([]);
    await findByText("prefs.md");
  });

  test("scope sections collapse and expand from their headers", async () => {
    fake = createFakeMemoryApi([fileInfo({ path: "/memories/global/prefs.md" })]);
    const { findByText, findByRole, queryByText } = render(<MemoryTab workspaceId="ws-1" />);
    await findByText("prefs.md");

    const header = await findByRole("button", { name: /global/i });
    expect(header.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(header);
    expect(queryByText("prefs.md")).toBeNull();
    expect(header.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(header);
    await findByText("prefs.md");
  });

  test("groups nested files under a collapsible directory node", async () => {
    fake = createFakeMemoryApi([
      fileInfo({ path: "/memories/global/topic/notes.md", scope: "global" }),
      fileInfo({ path: "/memories/global/root.md", scope: "global" }),
    ]);
    const { findByText, getByText, getByRole, getByLabelText, queryByText } = render(
      <MemoryTab workspaceId="ws-1" />
    );

    // The file renders under a directory node showing just its basename.
    const base = await findByText("notes.md");
    expect(base.textContent).toBe("notes.md");
    expect(queryByText("topic/")).toBeNull();
    const dirToggle = getByText("topic").closest("button")!;
    expect(dirToggle.getAttribute("aria-expanded")).toBe("true");
    // Pin/delete affordances still target the full scope-relative name.
    getByLabelText("Delete topic/notes.md");
    getByLabelText("Pin topic/notes.md");
    // The root file is not nested under any directory toggle.
    expect(getByText("root.md")).toBeTruthy();
    expect(getByRole("button", { name: "Delete root.md", hidden: true })).toBeTruthy();
  });

  test("collapsing a directory hides its files and nested directories", async () => {
    fake = createFakeMemoryApi([fileInfo({ path: "/memories/global/a/b/c.md", scope: "global" })]);
    const { findByText, getByText, queryByText } = render(<MemoryTab workspaceId="ws-1" />);

    // Multi-level nesting: a → b → c.md, expanded by default.
    await findByText("c.md");
    const outer = getByText("a").closest("button")!;
    fireEvent.click(outer);
    expect(outer.getAttribute("aria-expanded")).toBe("false");
    expect(queryByText("b")).toBeNull();
    expect(queryByText("c.md")).toBeNull();

    fireEvent.click(outer);
    await findByText("c.md");
  });

  test("directory counts include files in nested subdirectories", async () => {
    fake = createFakeMemoryApi([
      fileInfo({ path: "/memories/global/a/x.md", scope: "global" }),
      fileInfo({ path: "/memories/global/a/b/y.md", scope: "global" }),
    ]);
    const { findByText, getByText } = render(<MemoryTab workspaceId="ws-1" />);

    await findByText("x.md");
    expect(getByText("a").closest("button")!.textContent).toContain("(2)");
    expect(getByText("b").closest("button")!.textContent).toContain("(1)");
  });

  test("sorts directories before files, each alphabetically", async () => {
    fake = createFakeMemoryApi([
      fileInfo({ path: "/memories/global/zeta.md", scope: "global" }),
      fileInfo({ path: "/memories/global/beta/inner.md", scope: "global" }),
      fileInfo({ path: "/memories/global/alpha.md", scope: "global" }),
      fileInfo({ path: "/memories/global/acme/other.md", scope: "global" }),
    ]);
    const { findByText, getByText } = render(<MemoryTab workspaceId="ws-1" />);

    await findByText("alpha.md");
    const expectBefore = (first: HTMLElement, second: HTMLElement) => {
      expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    };
    expectBefore(getByText("acme"), getByText("beta"));
    expectBefore(getByText("beta"), getByText("alpha.md"));
    expectBefore(getByText("alpha.md"), getByText("zeta.md"));
  });

  test("marks files edited by the agent with a badge until opened", async () => {
    fake = createFakeMemoryApi([fileInfo({ path: "/memories/global/prefs.md" })]);
    fake.setContent("/memories/global/prefs.md", "likes tea", "sha-original");
    const { findByText, queryByText } = render(<MemoryTab workspaceId="ws-1" />);
    await findByText("prefs.md");
    expect(queryByText("agent edited")).toBeNull();

    fake.emitChange({
      scope: "global",
      path: "/memories/global/prefs.md",
      actor: "agent",
      workspaceId: "ws-other",
      projectPath: "/project/other",
    });
    await findByText("agent edited");

    // Opening the file acknowledges the badge.
    fireEvent.click(await findByText("prefs.md"));
    await waitFor(() => {
      expect(queryByText("agent edited")).toBeNull();
    });
  });

  test("user-actor change events do not produce the agent badge", async () => {
    fake = createFakeMemoryApi([fileInfo({ path: "/memories/global/prefs.md" })]);
    const { findByText, queryByText } = render(<MemoryTab workspaceId="ws-1" />);
    await findByText("prefs.md");

    fake.emitChange({
      scope: "global",
      path: "/memories/global/prefs.md",
      actor: "user",
      workspaceId: "ws-1",
      projectPath: "/project/one",
    });
    await waitFor(() => {
      expect(queryByText("agent edited")).toBeNull();
    });
  });
});
