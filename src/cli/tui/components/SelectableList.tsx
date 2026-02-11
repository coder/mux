import type { ReactNode } from "react";
import { Box, Text } from "ink";

interface SelectableListProps<T> {
  items: T[];
  selectedIndex: number;
  renderItem: (item: T, isSelected: boolean) => ReactNode;
  maxVisible?: number;
}

function clampIndex(index: number, itemCount: number): number {
  if (itemCount <= 0) {
    return 0;
  }

  if (index < 0) {
    return 0;
  }

  if (index >= itemCount) {
    return itemCount - 1;
  }

  return index;
}

function getItemKey<T>(item: T, fallbackIndex: number): string {
  if (item && typeof item === "object" && "id" in item) {
    const record = item as { id?: unknown };
    if (typeof record.id === "string" || typeof record.id === "number") {
      return String(record.id);
    }
  }

  return `item-${fallbackIndex}`;
}

export function SelectableList<T>(props: SelectableListProps<T>) {
  const maxVisible = props.maxVisible ?? 10;

  if (props.items.length === 0) {
    return <Text dimColor>No items</Text>;
  }

  const safeSelectedIndex = clampIndex(props.selectedIndex, props.items.length);
  const visibleCount = Math.min(maxVisible, props.items.length);
  const centeredStartIndex = safeSelectedIndex - Math.floor(visibleCount / 2);
  const maxStartIndex = Math.max(0, props.items.length - visibleCount);
  const startIndex = Math.min(Math.max(0, centeredStartIndex), maxStartIndex);
  const endIndex = startIndex + visibleCount;
  const visibleItems = props.items.slice(startIndex, endIndex);

  return (
    <Box flexDirection="column">
      {startIndex > 0 ? (
        <Text dimColor color="gray">
          {"  ↑ more"}
        </Text>
      ) : null}
      {visibleItems.map((item, offset) => {
        const listIndex = startIndex + offset;
        const isSelected = listIndex === safeSelectedIndex;
        const content = props.renderItem(item, isSelected);

        if (typeof content === "string" || typeof content === "number") {
          return (
            <Text color={isSelected ? "cyan" : undefined} key={getItemKey(item, listIndex)}>
              {isSelected ? "› " : "  "}
              {String(content)}
            </Text>
          );
        }

        return (
          <Box key={getItemKey(item, listIndex)}>
            <Text color={isSelected ? "cyan" : undefined}>{isSelected ? "› " : "  "}</Text>
            <Box flexDirection="column">{content}</Box>
          </Box>
        );
      })}
      {endIndex < props.items.length ? (
        <Text dimColor color="gray">
          {"  ↓ more"}
        </Text>
      ) : null}
    </Box>
  );
}
