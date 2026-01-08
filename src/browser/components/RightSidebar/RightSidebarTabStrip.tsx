import React from "react";
import { cn } from "@/common/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useDroppable, useDndContext } from "@dnd-kit/core";
import { Plus } from "lucide-react";
import { isTerminalTab, type TabType } from "@/browser/types/rightSidebar";

/** Data attached to dragged sidebar tabs */
export interface TabDragData {
  tab: TabType;
  sourceTabsetId: string;
  index: number;
}

export interface RightSidebarTabStripItem {
  id: string;
  panelId: string;
  selected: boolean;
  onSelect: () => void;
  label: React.ReactNode;
  tooltip: React.ReactNode;
  disabled?: boolean;
  /** The tab type (used for drag identification) */
  tab: TabType;
}

interface RightSidebarTabStripProps {
  items: RightSidebarTabStripItem[];
  ariaLabel?: string;
  /** Unique ID of this tabset (for drag/drop) */
  tabsetId: string;
  /** Called when a tab is dropped onto this tabset from another tabset */
  onTabDrop?: (tab: TabType, sourceTabsetId: string) => void;
  /** Called when tabs are reordered within this tabset */
  onTabReorder?: (fromIndex: number, toIndex: number) => void;
  /** Called when user clicks the "+" button to add a new terminal */
  onAddTerminal?: () => void;
}

export function getTabName(tab: TabType): string {
  if (isTerminalTab(tab)) {
    return "Terminal";
  }
  switch (tab) {
    case "costs":
      return "Costs";
    case "review":
      return "Review";
    case "stats":
      return "Stats";
    default:
      return tab;
  }
}

/**
 * Individual sortable tab button using @dnd-kit.
 * Uses useSortable for drag + drop within the same tabset.
 */
const SortableTab: React.FC<{
  item: RightSidebarTabStripItem;
  index: number;
  tabsetId: string;
}> = ({ item, index, tabsetId }) => {
  // Create a unique sortable ID that encodes tabset + tab
  const sortableId = `${tabsetId}:${item.tab}`;

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId,
    data: {
      tab: item.tab,
      sourceTabsetId: tabsetId,
      index,
    } satisfies TabDragData,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div className="relative" style={style}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            ref={setNodeRef}
            {...attributes}
            {...listeners}
            className={cn(
              "flex items-baseline gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-all duration-150",
              "cursor-grab touch-none active:cursor-grabbing",
              item.selected
                ? "bg-hover text-foreground"
                : "bg-transparent text-muted hover:bg-hover/50 hover:text-foreground",
              item.disabled && "pointer-events-none opacity-50",
              isDragging && "cursor-grabbing opacity-50"
            )}
            onClick={item.onSelect}
            id={item.id}
            role="tab"
            type="button"
            aria-selected={item.selected}
            aria-controls={item.panelId}
            disabled={item.disabled}
          >
            {item.label}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center">
          {item.tooltip}
        </TooltipContent>
      </Tooltip>
    </div>
  );
};

export const RightSidebarTabStrip: React.FC<RightSidebarTabStripProps> = ({
  items,
  ariaLabel = "Sidebar views",
  tabsetId,
  onTabDrop,
  onAddTerminal,
}) => {
  const { active } = useDndContext();
  const activeData = active?.data.current as TabDragData | undefined;

  // Track if we're dragging from this tabset (for visual feedback)
  const isDraggingFromHere = activeData?.sourceTabsetId === tabsetId;

  // Make the tabstrip a drop target for tabs from OTHER tabsets
  const { setNodeRef, isOver } = useDroppable({
    id: `tabstrip:${tabsetId}`,
    data: { tabsetId },
  });

  const canDrop = activeData && activeData.sourceTabsetId !== tabsetId;
  const showDropHighlight = isOver && canDrop;

  // Handle drops from other tabsets
  React.useEffect(() => {
    if (isOver && canDrop && activeData && onTabDrop) {
      // The actual drop is handled by onDragEnd in the parent DndContext
    }
  }, [isOver, canDrop, activeData, onTabDrop]);

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "border-border-light flex items-center gap-1 border-b px-2 py-1.5 transition-colors",
        showDropHighlight && "bg-accent/30",
        isDraggingFromHere && "bg-accent/10"
      )}
      role="tablist"
      aria-label={ariaLabel}
    >
      {items.map((item, index) => (
        <SortableTab key={item.id} item={item} index={index} tabsetId={tabsetId} />
      ))}
      {onAddTerminal && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="text-muted hover:bg-hover hover:text-foreground ml-auto rounded-md p-1 transition-colors"
              onClick={onAddTerminal}
              aria-label="New terminal"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">New terminal</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
};
