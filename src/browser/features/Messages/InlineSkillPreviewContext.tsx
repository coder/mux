import { createContext, type ReactNode } from "react";

export interface InlineSkillPreviewContextValue {
  renderInlineSkillPreview: (skillName: string, label: string) => ReactNode;
}

export const InlineSkillPreviewContext = createContext<InlineSkillPreviewContextValue>({
  renderInlineSkillPreview: (_skillName, label) => label,
});
