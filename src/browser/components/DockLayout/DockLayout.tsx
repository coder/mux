import React from "react";
import { cn } from "@/common/lib/utils";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import {
  dockTabToEdge,
  moveTabToTabset,
  reorderTabInTabset,
  selectTabInTabset,
  setFocusedTabset,
  updateSplitSizes,
  type DockLayoutNode,
  type DockLayoutState,
} from "@/browser/utils/dockLayout";
import {
  DockLayoutTabStrip,
  type DockLayoutTabStripItem,
  type DockTabDragData,
} from "./DockLayoutTabStrip";

export interface DockPaneDescriptor {
  title: React.ReactNode;
  tooltip?: React.ReactNode;
  render: () => React.ReactNode;
  keepAlive?: boolean;
  /** If false, this tab cannot be dragged/reordered/docked. */
  draggable?: boolean;
  canClose?: boolean;
  onClose?: () => void;
  /** Optional override for the pane content container (defaults to flex-1 min-h-0) */
  contentClassName?: string;
}

interface DragAwarePanelResizeHandleProps {
  direction: "horizontal" | "vertical";
  isDraggingTab: boolean;
}

function DragAwarePanelResizeHandle(props: DragAwarePanelResizeHandleProps) {
  const className = cn(
    props.direction === "horizontal"
      ? "w-0.5 flex-shrink-0 z-10 transition-[background] duration-150 cursor-col-resize bg-border-light hover:bg-accent"
      : "h-0.5 flex-shrink-0 z-10 transition-[background] duration-150 cursor-row-resize bg-border-light hover:bg-accent",
    props.isDraggingTab && "pointer-events-none"
  );

  return <PanelResizeHandle className={className} />;
}

type TabsetNode<PaneId extends string> = Extract<DockLayoutNode<PaneId>, { type: "tabset" }>;

interface DockLayoutTabsetNodeProps<PaneId extends string> {
  node: TabsetNode<PaneId>;
  baseId: string;
  isDraggingTab: boolean;
  setLayout: (updater: (prev: DockLayoutState<PaneId>) => DockLayoutState<PaneId>) => void;
  getPaneDescriptor: (paneId: PaneId) => DockPaneDescriptor;
}

function DockLayoutTabsetNode<PaneId extends string>(props: DockLayoutTabsetNodeProps<PaneId>) {
  const tabsetBaseId = `${props.baseId}-${props.node.id}`;

  const { setNodeRef: contentRef, isOver: isOverContent } = useDroppable({
    id: `content:${props.node.id}`,
    data: { type: "content", tabsetId: props.node.id },
  });

  const { setNodeRef: topRef, isOver: isOverTop } = useDroppable({
    id: `edge:${props.node.id}:top`,
    data: { type: "edge", tabsetId: props.node.id, edge: "top" },
  });

  const { setNodeRef: bottomRef, isOver: isOverBottom } = useDroppable({
    id: `edge:${props.node.id}:bottom`,
    data: { type: "edge", tabsetId: props.node.id, edge: "bottom" },
  });

  const { setNodeRef: leftRef, isOver: isOverLeft } = useDroppable({
    id: `edge:${props.node.id}:left`,
    data: { type: "edge", tabsetId: props.node.id, edge: "left" },
  });

  const { setNodeRef: rightRef, isOver: isOverRight } = useDroppable({
    id: `edge:${props.node.id}:right`,
    data: { type: "edge", tabsetId: props.node.id, edge: "right" },
  });

  const showDockHints =
    props.isDraggingTab &&
    (isOverContent || isOverTop || isOverBottom || isOverLeft || isOverRight);

  const setFocused = () => {
    props.setLayout((prev) => setFocusedTabset(prev, props.node.id));
  };

  const selectTab = (tab: PaneId) => {
    props.setLayout((prev) => {
      const withFocus = setFocusedTabset(prev, props.node.id);
      return selectTabInTabset(withFocus, props.node.id, tab);
    });
  };

  const items: Array<DockLayoutTabStripItem<PaneId>> = props.node.tabs.map((tab) => {
    const descriptor = props.getPaneDescriptor(tab);

    const tabId = `${tabsetBaseId}-tab-${tab}`;
    const panelId = `${tabsetBaseId}-panel-${tab}`;

    return {
      id: tabId,
      panelId,
      selected: props.node.activeTab === tab,
      onSelect: () => selectTab(tab),
      label: descriptor.title,
      tooltip: descriptor.tooltip,
      tab,
      disabled: descriptor.draggable === false,
      onClose: descriptor.canClose ? descriptor.onClose : undefined,
    };
  });

  const sortableIds = items.map((item) => `${props.node.id}:${item.tab}`);

  const activeDescriptor = props.getPaneDescriptor(props.node.activeTab);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" onMouseDownCapture={setFocused}>
      <SortableContext items={sortableIds} strategy={rectSortingStrategy}>
        <DockLayoutTabStrip tabsetId={props.node.id} items={items} />
      </SortableContext>

      <div
        ref={contentRef}
        className={cn(
          "relative flex-1 min-h-0",
          activeDescriptor.contentClassName,
          props.isDraggingTab && isOverContent && "bg-accent/10 ring-1 ring-accent/50"
        )}
      >
        {/* Edge docking zones - always rendered but only visible/interactive during drag */}
        <div
          ref={topRef}
          className={cn(
            "absolute inset-x-0 top-0 z-10 h-10 transition-opacity",
            props.isDraggingTab
              ? showDockHints
                ? "opacity-100"
                : "opacity-0"
              : "opacity-0 pointer-events-none",
            isOverTop ? "bg-accent/20 border-b border-accent" : "bg-accent/5"
          )}
        />
        <div
          ref={bottomRef}
          className={cn(
            "absolute inset-x-0 bottom-0 z-10 h-10 transition-opacity",
            props.isDraggingTab
              ? showDockHints
                ? "opacity-100"
                : "opacity-0"
              : "opacity-0 pointer-events-none",
            isOverBottom ? "bg-accent/20 border-t border-accent" : "bg-accent/5"
          )}
        />
        <div
          ref={leftRef}
          className={cn(
            "absolute inset-y-0 left-0 z-10 w-10 transition-opacity",
            props.isDraggingTab
              ? showDockHints
                ? "opacity-100"
                : "opacity-0"
              : "opacity-0 pointer-events-none",
            isOverLeft ? "bg-accent/20 border-r border-accent" : "bg-accent/5"
          )}
        />
        <div
          ref={rightRef}
          className={cn(
            "absolute inset-y-0 right-0 z-10 w-10 transition-opacity",
            props.isDraggingTab
              ? showDockHints
                ? "opacity-100"
                : "opacity-0"
              : "opacity-0 pointer-events-none",
            isOverRight ? "bg-accent/20 border-l border-accent" : "bg-accent/5"
          )}
        />

        {props.node.tabs.map((tab) => {
          const descriptor = props.getPaneDescriptor(tab);
          const panelId = `${tabsetBaseId}-panel-${tab}`;
          const tabId = `${tabsetBaseId}-tab-${tab}`;
          const isActive = props.node.activeTab === tab;

          if (!descriptor.keepAlive && !isActive) {
            return null;
          }

          return (
            <div
              key={panelId}
              role="tabpanel"
              id={panelId}
              aria-labelledby={tabId}
              className="h-full"
              hidden={!isActive}
            >
              {descriptor.render()}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export interface DockLayoutProps<PaneId extends string> {
  layout: DockLayoutState<PaneId>;
  setLayout: (updater: (prev: DockLayoutState<PaneId>) => DockLayoutState<PaneId>) => void;
  getPaneDescriptor: (paneId: PaneId) => DockPaneDescriptor;
  getFallbackTabForEmptyTabset: (movedTab: PaneId) => PaneId;
  baseId: string;
  className?: string;
  panelMinSize?: number;
  onTabDragStart?: () => void;
  onTabDragEnd?: () => void;
}

export function DockLayout<PaneId extends string>(props: DockLayoutProps<PaneId>) {
  const [activeDragData, setActiveDragData] = React.useState<DockTabDragData<PaneId> | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  );

  const handleDragStart = React.useCallback(
    (event: DragStartEvent) => {
      const data = event.active.data.current as DockTabDragData<PaneId> | undefined;
      if (data) {
        props.onTabDragStart?.();
        setActiveDragData(data);
      }
    },
    [props]
  );

  const handleDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      const activeData = active.data.current as DockTabDragData<PaneId> | undefined;

      if (activeData && over) {
        const overData = over.data.current as
          | { type: "edge"; tabsetId: string; edge: "top" | "bottom" | "left" | "right" }
          | { type: "content"; tabsetId: string }
          | { tabsetId: string }
          | DockTabDragData<PaneId>
          | undefined;

        if (overData) {
          if ("type" in overData && overData.type === "edge") {
            props.setLayout((prev) =>
              dockTabToEdge(
                prev,
                activeData.tab,
                activeData.sourceTabsetId,
                overData.tabsetId,
                overData.edge,
                props.getFallbackTabForEmptyTabset
              )
            );
          } else if ("type" in overData && overData.type === "content") {
            if (activeData.sourceTabsetId !== overData.tabsetId) {
              props.setLayout((prev) =>
                moveTabToTabset(prev, activeData.tab, activeData.sourceTabsetId, overData.tabsetId)
              );
            }
          } else if ("tabsetId" in overData && !("tab" in overData)) {
            if (activeData.sourceTabsetId !== overData.tabsetId) {
              props.setLayout((prev) =>
                moveTabToTabset(prev, activeData.tab, activeData.sourceTabsetId, overData.tabsetId)
              );
            }
          } else if ("tab" in overData && "sourceTabsetId" in overData) {
            if (activeData.sourceTabsetId === overData.sourceTabsetId) {
              const fromIndex = activeData.index;
              const toIndex = overData.index;
              if (fromIndex !== toIndex) {
                props.setLayout((prev) =>
                  reorderTabInTabset(prev, activeData.sourceTabsetId, fromIndex, toIndex)
                );
              }
            } else {
              props.setLayout((prev) =>
                moveTabToTabset(
                  prev,
                  activeData.tab,
                  activeData.sourceTabsetId,
                  overData.sourceTabsetId
                )
              );
            }
          }
        }
      }

      props.onTabDragEnd?.();
      setActiveDragData(null);
    },
    [props]
  );

  const isDraggingTab = activeDragData !== null;

  const renderLayoutNode = (node: DockLayoutNode<PaneId>): React.ReactNode => {
    if (node.type === "split") {
      // Our layout uses "horizontal" to mean a horizontal divider (top/bottom panes).
      // react-resizable-panels uses "vertical" for top/bottom.
      const groupDirection = node.direction === "horizontal" ? "vertical" : "horizontal";

      return (
        <PanelGroup
          direction={groupDirection}
          className="flex min-h-0 min-w-0 flex-1"
          onLayout={(sizes) => {
            if (sizes.length !== 2) return;
            const nextSizes: [number, number] = [
              typeof sizes[0] === "number" ? sizes[0] : 50,
              typeof sizes[1] === "number" ? sizes[1] : 50,
            ];
            props.setLayout((prev) => updateSplitSizes(prev, node.id, nextSizes));
          }}
        >
          <Panel
            defaultSize={node.sizes[0]}
            minSize={props.panelMinSize ?? 15}
            className="flex min-h-0 min-w-0 flex-col"
          >
            {renderLayoutNode(node.children[0])}
          </Panel>
          <DragAwarePanelResizeHandle direction={groupDirection} isDraggingTab={isDraggingTab} />
          <Panel
            defaultSize={node.sizes[1]}
            minSize={props.panelMinSize ?? 15}
            className="flex min-h-0 min-w-0 flex-col"
          >
            {renderLayoutNode(node.children[1])}
          </Panel>
        </PanelGroup>
      );
    }

    return (
      <DockLayoutTabsetNode
        key={node.id}
        node={node}
        baseId={props.baseId}
        isDraggingTab={isDraggingTab}
        getPaneDescriptor={props.getPaneDescriptor}
        setLayout={props.setLayout}
      />
    );
  };

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", props.className)}>
        {renderLayoutNode(props.layout.root)}
      </div>

      <DragOverlay>
        {activeDragData ? (
          <div className="border-border bg-background/95 cursor-grabbing rounded-md border px-3 py-1 text-xs font-medium shadow">
            {props.getPaneDescriptor(activeDragData.tab).title}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
