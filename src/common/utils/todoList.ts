import type { TodoItem } from "@/common/types/tools";

type TodoLikeStatus = TodoItem["status"];

interface TodoLikeItem {
  status: TodoLikeStatus;
}

export function renderTodoItemsAsMarkdownList(todos: TodoItem[]): string {
  return todos
    .map((todo) => {
      const statusMarker =
        todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[>]" : "[ ]";
      return `- ${statusMarker} ${todo.content}`;
    })
    .join("\n");
}

/**
 * `propose_plan` ends the active planning turn immediately, so any in-progress
 * todo steps need to flip to completed even though the model does not get a
 * follow-up turn to call `todo_write` again.
 */
export function completeInProgressTodoItems<T extends TodoLikeItem>(todos: T[]): T[] {
  let changed = false;
  const nextTodos = todos.map((todo) => {
    if (todo.status !== "in_progress") {
      return todo;
    }

    changed = true;
    return { ...todo, status: "completed" };
  });

  return changed ? nextTodos : todos;
}
