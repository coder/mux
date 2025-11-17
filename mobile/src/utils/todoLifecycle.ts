import { assert } from "./assert";
import type { WorkspaceChatEvent, DisplayedMessage } from "../types";
import type { TodoItem } from "../components/TodoItemView";

const TODO_STATUSES: ReadonlyArray<TodoItem["status"]> = ["pending", "in_progress", "completed"];

function isTodoStatus(value: unknown): value is TodoItem["status"] {
  return TODO_STATUSES.includes(value as TodoItem["status"]);
}

type TodoWriteMessage = DisplayedMessage & {
  type: "tool";
  toolName: "todo_write";
  args: { todos: unknown };
  status: "pending" | "executing" | "completed" | "failed" | "interrupted";
};

function isTodoWriteMessage(event: WorkspaceChatEvent): event is TodoWriteMessage {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as { type?: unknown }).type === "tool" &&
    (event as { toolName?: unknown }).toolName === "todo_write" &&
    (event as { status?: unknown }).status === "completed"
  );
}

function validateTodos(todos: TodoItem[]): void {
  todos.forEach((todo, index) => {
    assert(typeof todo === "object" && todo !== null, `Todo at index ${index} must be an object`);
    assert(typeof todo.content === "string", `Todo at index ${index} must include content`);
    assert(
      isTodoStatus(todo.status),
      `Todo at index ${index} has invalid status: ${String(todo.status)}`
    );
  });
}

export function extractTodosFromEvent(event: WorkspaceChatEvent): TodoItem[] | null {
  if (!isTodoWriteMessage(event)) {
    return null;
  }

  const todos = (event.args as { todos: unknown }).todos;
  assert(Array.isArray(todos), "todo_write args.todos must be an array");
  validateTodos(todos as TodoItem[]);
  return todos as TodoItem[];
}

export function areTodosEqual(a: TodoItem[], b: TodoItem[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((todo, index) => {
    const candidate = b[index];
    return todo.content === candidate.content && todo.status === candidate.status;
  });
}
