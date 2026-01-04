import React from "react";
import { useProjectContext } from "@/browser/contexts/ProjectContext";

interface SectionSelectorProps {
  projectPath: string;
  selectedSectionId: string | null;
  onSectionChange: (sectionId: string | null) => void;
}

/**
 * Section selector for workspace creation.
 * Only renders when the project has sections.
 */
export const SectionSelector: React.FC<SectionSelectorProps> = ({
  projectPath,
  selectedSectionId,
  onSectionChange,
}) => {
  const { projects } = useProjectContext();
  const project = projects.get(projectPath);
  const sections = project?.sections ?? [];

  // Don't render if no sections exist
  if (sections.length === 0) {
    return null;
  }

  return (
    <div
      className="text-muted flex items-center gap-2 text-xs"
      data-testid="section-selector"
      data-selected-section={selectedSectionId ?? ""}
    >
      <span>Section:</span>
      <select
        value={selectedSectionId ?? ""}
        onChange={(e) => onSectionChange(e.target.value || null)}
        className="bg-background border-border text-foreground rounded border px-2 py-1 text-xs"
      >
        <option value="">None</option>
        {sections.map((section) => (
          <option key={section.id} value={section.id}>
            {section.name}
          </option>
        ))}
      </select>
    </div>
  );
};
