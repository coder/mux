import React from "react";
import { useDragLayer } from "react-dnd";
import { cn } from "@/common/lib/utils";
import { SECTION_DRAG_TYPE, type SectionDragItem } from "./DraggableSection";
import { ChevronRight } from "lucide-react";

/**
 * Custom drag layer for section drag-drop reordering.
 * Renders a preview of the section being dragged.
 */
export const SectionDragLayer: React.FC = () => {
  const dragState = useDragLayer<{
    isDragging: boolean;
    item: unknown;
    itemType: string | symbol | null;
    currentOffset: { x: number; y: number } | null;
  }>((monitor) => ({
    isDragging: monitor.isDragging(),
    item: monitor.getItem(),
    itemType: monitor.getItemType(),
    currentOffset: monitor.getClientOffset(),
  }));

  const { isDragging, item, itemType, currentOffset } = dragState;

  // Only render for section drags
  if (!isDragging || itemType !== SECTION_DRAG_TYPE || !currentOffset) {
    return null;
  }

  const sectionItem = item as SectionDragItem & { sectionName?: string };
  const displayName = sectionItem.sectionName ?? "Section";

  return (
    <div className="pointer-events-none fixed inset-0 z-[9999]">
      <div
        style={{
          transform: `translate(${currentOffset.x + 10}px, ${currentOffset.y + 10}px)`,
        }}
      >
        <div
          className={cn(
            "flex max-w-48 items-center gap-1.5 rounded-sm px-2 py-1.5",
            "bg-sidebar border-border border shadow-lg"
          )}
        >
          <ChevronRight size={12} className="text-muted shrink-0" />
          <span className="text-foreground truncate text-xs font-medium">{displayName}</span>
        </div>
      </div>
    </div>
  );
};
