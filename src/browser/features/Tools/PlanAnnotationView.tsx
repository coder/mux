import React from "react";
import { SelectableDiffRenderer } from "@/browser/features/Shared/DiffRenderer";
import type { ReviewActionCallbacks } from "@/browser/features/Shared/InlineReviewNote";
import type { Review, ReviewNoteData } from "@/common/types/review";

export interface PlanAnnotationViewProps {
  planContent: string;
  planPath?: string;
  onReviewNote?: (data: ReviewNoteData) => void;
  reviews: Review[];
  reviewActions: ReviewActionCallbacks;
}

function toSelectableContent(planContent: string): string {
  const lines = planContent.split("\n");
  const normalizedLines = lines.filter((line, idx) => idx < lines.length - 1 || line !== "");

  // SelectableDiffRenderer expects diff-formatted lines. Prefixing each plan line with a
  // space marks it as a context line so line numbers + range selection work for annotations.
  return normalizedLines.map((line) => ` ${line}`).join("\n");
}

export const PlanAnnotationView: React.FC<PlanAnnotationViewProps> = (props) => {
  const selectableContent = toSelectableContent(props.planContent);

  return (
    <div className="max-h-[70vh] overflow-auto rounded">
      <SelectableDiffRenderer
        content={selectableContent}
        filePath={props.planPath ?? "plan.md"}
        onReviewNote={props.onReviewNote}
        inlineReviews={props.reviews}
        reviewActions={props.reviewActions}
        showLineNumbers={true}
        lineNumberMode="new"
        oldStart={1}
        newStart={1}
        fontSize="12px"
        maxHeight="none"
      />
    </div>
  );
};
