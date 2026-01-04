import React, { useEffect } from "react";
import { useDrag, useDrop } from "react-dnd";
import { getEmptyImage } from "react-dnd-html5-backend";
import { cn } from "@/common/lib/utils";

const SECTION_DRAG_TYPE = "SECTION_REORDER";

export interface SectionDragItem {
  type: typeof SECTION_DRAG_TYPE;
  sectionId: string;
  sectionName: string;
  projectPath: string;
}

interface DraggableSectionProps {
  sectionId: string;
  sectionName: string;
  projectPath: string;
  /** Called when a section is dropped onto this section (reorder) */
  onReorder: (draggedSectionId: string, targetSectionId: string) => void;
  children: React.ReactNode;
}

/**
 * Wrapper that makes a section draggable for reordering.
 * Sections can be dragged and dropped onto other sections within the same project.
 */
export const DraggableSection: React.FC<DraggableSectionProps> = ({
  sectionId,
  sectionName,
  projectPath,
  onReorder,
  children,
}) => {
  const [{ isDragging }, drag, dragPreview] = useDrag(
    () => ({
      type: SECTION_DRAG_TYPE,
      item: {
        type: SECTION_DRAG_TYPE,
        sectionId,
        sectionName,
        projectPath,
      } satisfies SectionDragItem,
      collect: (monitor) => ({
        isDragging: monitor.isDragging(),
      }),
    }),
    [sectionId, sectionName, projectPath]
  );

  // Hide native drag preview
  useEffect(() => {
    dragPreview(getEmptyImage(), { captureDraggingState: true });
  }, [dragPreview]);

  const [{ isOver, canDrop }, drop] = useDrop(
    () => ({
      accept: SECTION_DRAG_TYPE,
      canDrop: (item: SectionDragItem) => {
        // Can only drop if from same project and different section
        return item.projectPath === projectPath && item.sectionId !== sectionId;
      },
      drop: (item: SectionDragItem) => {
        onReorder(item.sectionId, sectionId);
      },
      collect: (monitor) => ({
        isOver: monitor.isOver(),
        canDrop: monitor.canDrop(),
      }),
    }),
    [projectPath, sectionId, onReorder]
  );

  return (
    <div
      ref={(node) => drag(drop(node))}
      data-section-drag-id={sectionId}
      className={cn(isDragging && "opacity-50", isOver && canDrop && "bg-accent/10")}
    >
      {children}
    </div>
  );
};

export { SECTION_DRAG_TYPE };
