import type { TodoItem } from "@/common/types/tools";

export function renderTodoItemsAsMarkdownList(todos: TodoItem[]): string {
  return todos
    .map((todo) => {
      const statusMarker =
        todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[>]" : "[ ]";
      return `- ${statusMarker} ${todo.content}`;
    })
    .join("\n");
}
