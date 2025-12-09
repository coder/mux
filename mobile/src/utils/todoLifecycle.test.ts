import { describe, expect, it } from "bun:test";
import type { WorkspaceChatEvent } from "../types";
import type { TodoItem } from "../components/TodoItemView";
import { areTodosEqual, extractTodosFromEvent } from "./todoLifecycle";

describe("todoLifecycle", () => {
  const baseToolEvent: WorkspaceChatEvent = {
    type: "tool",
    id: "event-1",
    historyId: "history-1",
    toolCallId: "call-1",
    toolName: "todo_write",
    args: { todos: [] },
    status: "completed",
    isPartial: false,
    historySequence: 1,
  } as const;

  it("returns null for non todo_write events", () => {
    const nonTodoEvent: WorkspaceChatEvent = {
      type: "assistant",
      id: "assistant-1",
      historyId: "history-1",
      content: "Hello",
      isStreaming: false,
      isPartial: false,
      isCompacted: false,
      historySequence: 1,
    } as const;

    expect(extractTodosFromEvent(nonTodoEvent)).toBeNull();
  });

  it("extracts todos from completed todo_write tool", () => {
    const todos: TodoItem[] = [
      { content: "Check logs", status: "in_progress" },
      { content: "Fix bug", status: "pending" },
    ];

    const event: WorkspaceChatEvent = {
      ...baseToolEvent,
      args: { todos },
    } as const;

    const extracted = extractTodosFromEvent(event);
    expect(extracted).not.toBeNull();
    expect(extracted).toEqual(todos);
  });

  it("throws when todo_write payload is malformed", () => {
    const missingTodos = {
      ...baseToolEvent,
      args: {},
    } as WorkspaceChatEvent;

    expect(() => extractTodosFromEvent(missingTodos)).toThrow("must be an array");

    const invalidStatus = {
      ...baseToolEvent,
      args: { todos: [{ content: "Item", status: "done" }] },
    } as unknown as WorkspaceChatEvent;

    expect(() => extractTodosFromEvent(invalidStatus)).toThrow("invalid status");
  });

  it("compares todo arrays by value", () => {
    const todos: TodoItem[] = [
      { content: "A", status: "pending" },
      { content: "B", status: "completed" },
    ];

    expect(areTodosEqual(todos, [...todos])).toBe(true);
    expect(
      areTodosEqual(todos, [
        { content: "A", status: "pending" },
        { content: "B", status: "pending" },
      ])
    ).toBe(false);
    expect(areTodosEqual(todos, todos.slice(0, 1))).toBe(false);
  });
});
