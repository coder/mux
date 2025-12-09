import type {
  PostCompactionAttachment,
  PlanFileReferenceAttachment,
  EditedFilesReferenceAttachment,
} from "@/common/types/attachment";

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
    case "edited_files_reference":
      return renderEditedFilesReference(attachment);
  }
}

/**
 * Render multiple post-compaction attachments to a single content string.
 * Each attachment is wrapped in a <system-update> tag.
 */
export function renderAttachmentsToContent(attachments: PostCompactionAttachment[]): string {
  return attachments
    .map((att) => `<system-update>\n${renderAttachmentToContent(att)}\n</system-update>`)
    .join("\n");
}
