import type {
  PostCompactionAttachment,
  PlanFileReferenceAttachment,
  TodoListAttachment,
  EditedFilesReferenceAttachment,
} from "@/common/types/attachment";
import { renderTodoItemsAsMarkdownList } from "@/common/utils/todoList";

const SYSTEM_UPDATE_OPEN = "<system-update>\n";
const SYSTEM_UPDATE_CLOSE = "\n</system-update>";

function wrapSystemUpdate(content: string): string {
  return `${SYSTEM_UPDATE_OPEN}${content}${SYSTEM_UPDATE_CLOSE}`;
}

/**
 * Render a plan file reference attachment to content string.
 */
function renderPlanFileReference(attachment: PlanFileReferenceAttachment): string {
  return `A plan file exists from plan mode at: ${attachment.planFilePath}

Plan contents:
${attachment.planContent}

If this plan is relevant to the current work and not already complete, continue working on it.`;
}

/**
 * Render a todo list attachment to a content string.
 */
function renderTodoListAttachment(attachment: TodoListAttachment): string {
  const items = renderTodoItemsAsMarkdownList(attachment.todos);
  return `TODO list (persisted; \`todo_read\` will return this):\n${items || "- (empty)"}`;
}

/**
 * Render an edited files reference attachment to content string.
 */
function renderEditedFilesReference(attachment: EditedFilesReferenceAttachment): string {
  const fileEntries = attachment.files
    .map((file) => {
      const truncationNote = file.truncated ? " (truncated)" : "";
      return `File: ${file.path}${truncationNote}
\`\`\`diff
${file.diff}
\`\`\``;
    })
    .join("\n\n");

  return `The following files were edited in this session:

${fileEntries}`;
}

/**
 * Render a single post-compaction attachment to its content string.
 */
export function renderAttachmentToContent(attachment: PostCompactionAttachment): string {
  switch (attachment.type) {
    case "plan_file_reference":
      return renderPlanFileReference(attachment);
    case "todo_list":
      return renderTodoListAttachment(attachment);
    case "edited_files_reference":
      return renderEditedFilesReference(attachment);
  }
}

/**
 * Render multiple post-compaction attachments to a single content string.
 * Each attachment is wrapped in a <system-update> tag.
 */
export function renderAttachmentsToContent(attachments: PostCompactionAttachment[]): string {
  return attachments.map((att) => wrapSystemUpdate(renderAttachmentToContent(att))).join("\n");
}

const PLAN_TRUNCATION_NOTE = "\n\n...(truncated)\n";

function renderPlanFileReferenceWithBudget(
  attachment: PlanFileReferenceAttachment,
  maxChars: number
): string | null {
  if (maxChars <= 0) {
    return null;
  }

  const prefix = `A plan file exists from plan mode at: ${attachment.planFilePath}\n\nPlan contents:\n`;
  const suffix =
    "\n\nIf this plan is relevant to the current work and not already complete, continue working on it.";

  const availableForContent = maxChars - prefix.length - suffix.length;
  if (availableForContent <= 0) {
    const minimal = `A plan file exists from plan mode at: ${attachment.planFilePath}`;
    return minimal.length <= maxChars ? minimal : null;
  }

  let planContent = attachment.planContent;
  if (planContent.length > availableForContent) {
    const sliceLength = Math.max(0, availableForContent - PLAN_TRUNCATION_NOTE.length);
    planContent = `${planContent.slice(0, sliceLength)}${PLAN_TRUNCATION_NOTE}`;
  }

  return `${prefix}${planContent}${suffix}`;
}

function renderEditedFilesReferenceWithBudget(
  attachment: EditedFilesReferenceAttachment,
  maxChars: number
): { content: string | null; omittedFiles: number } {
  const header = "The following files were edited in this session:\n\n";

  if (maxChars <= header.length) {
    return { content: null, omittedFiles: attachment.files.length };
  }

  const entries: string[] = [];
  let used = header.length;

  for (const file of attachment.files) {
    const truncationNote = file.truncated ? " (truncated)" : "";
    const entry = `File: ${file.path}${truncationNote}\n\`\`\`diff\n${file.diff}\n\`\`\``;
    const separator = entries.length > 0 ? "\n\n" : "";
    const nextLen = used + separator.length + entry.length;

    if (nextLen > maxChars) {
      break;
    }

    entries.push(entry);
    used = nextLen;
  }

  const included = entries.length;
  const omittedFiles = attachment.files.length - included;

  if (included === 0) {
    return { content: null, omittedFiles: attachment.files.length };
  }

  return {
    content: `${header}${entries.join("\n\n")}`,
    omittedFiles,
  };
}

function sortAttachmentsForInjection(
  attachments: PostCompactionAttachment[]
): PostCompactionAttachment[] {
  const priority: Record<PostCompactionAttachment["type"], number> = {
    plan_file_reference: 0,
    todo_list: 1,
    edited_files_reference: 2,
  };

  return attachments
    .map((att, index) => ({ att, index }))
    .sort((a, b) => {
      const diff = priority[a.att.type] - priority[b.att.type];
      return diff !== 0 ? diff : a.index - b.index;
    })
    .map((item) => item.att);
}

export function renderAttachmentsToContentWithBudget(
  attachments: PostCompactionAttachment[],
  options: { maxChars: number }
): string {
  const maxChars = Math.max(0, Math.floor(options.maxChars));
  if (attachments.length === 0 || maxChars === 0) {
    return "";
  }

  const ordered = sortAttachmentsForInjection(attachments);

  const blocks: string[] = [];
  let currentLength = 0;
  let omittedFileDiffs = 0;

  const addBlock = (block: string): boolean => {
    const separatorLen = blocks.length > 0 ? "\n".length : 0;
    const nextLength = currentLength + separatorLen + block.length;
    if (nextLength > maxChars) {
      return false;
    }

    blocks.push(block);
    currentLength = nextLength;
    return true;
  };

  for (const attachment of ordered) {
    const separatorLen = blocks.length > 0 ? "\n".length : 0;
    const remainingForBlock = maxChars - currentLength - separatorLen;
    const remainingForContent =
      remainingForBlock - SYSTEM_UPDATE_OPEN.length - SYSTEM_UPDATE_CLOSE.length;

    if (remainingForContent <= 0) {
      break;
    }

    if (attachment.type === "plan_file_reference") {
      const content = renderPlanFileReferenceWithBudget(attachment, remainingForContent);
      if (content) {
        addBlock(wrapSystemUpdate(content));
      }
      continue;
    }

    if (attachment.type === "todo_list") {
      const content = renderTodoListAttachment(attachment);
      if (content.length <= remainingForContent) {
        addBlock(wrapSystemUpdate(content));
      }
      continue;
    }

    if (attachment.type === "edited_files_reference") {
      const { content, omittedFiles } = renderEditedFilesReferenceWithBudget(
        attachment,
        remainingForContent
      );
      omittedFileDiffs += omittedFiles;

      if (content) {
        addBlock(wrapSystemUpdate(content));
      }
      continue;
    }
  }

  if (omittedFileDiffs > 0) {
    const plural = omittedFileDiffs === 1 ? "" : "s";
    const note = `(post-compaction context truncated; omitted ${omittedFileDiffs} file diff${plural})`;
    addBlock(wrapSystemUpdate(note));
  }

  if (blocks.length === 0) {
    const note = "(post-compaction context omitted due to size)";
    if (note.length + SYSTEM_UPDATE_OPEN.length + SYSTEM_UPDATE_CLOSE.length <= maxChars) {
      blocks.push(wrapSystemUpdate(note));
    }
  }

  return blocks.join("\n");
}
