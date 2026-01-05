import type { SectionConfig } from "@/common/types/project";

/**
 * Sort sections by their linked-list order (nextId pointers).
 *
 * Finds the head (section not referenced by any other's nextId),
 * then follows the chain. Orphaned sections are appended at the end.
 */
export function sortSectionsByLinkedList(sections: SectionConfig[]): SectionConfig[] {
  if (sections.length === 0) return [];

  const byId = new Map(sections.map((s) => [s.id, s]));

  // Find head: section not referenced by any other section's nextId
  const referencedIds = new Set(sections.map((s) => s.nextId).filter(Boolean));
  const heads = sections.filter((s) => !referencedIds.has(s.id));

  // If no clear head (cycle or empty), fall back to first section
  const head = heads[0] ?? sections[0];

  const sorted: SectionConfig[] = [];
  const visited = new Set<string>();
  let current: SectionConfig | undefined = head;

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    sorted.push(current);
    current = current.nextId ? byId.get(current.nextId) : undefined;
  }

  // Append orphaned sections (not in linked list)
  for (const s of sections) {
    if (!visited.has(s.id)) {
      sorted.push(s);
    }
  }

  return sorted;
}
