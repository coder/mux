export function matchesHyphenatedPrefix(name: string, partial: string): boolean {
  const normalizedPartial = partial.trim().toLowerCase();
  const normalizedName = name.toLowerCase();

  return (
    normalizedPartial.length === 0 ||
    normalizedName.startsWith(normalizedPartial) ||
    normalizedName.split("-").some((segment) => segment.startsWith(normalizedPartial))
  );
}
