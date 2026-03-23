/** Pluralize a repo count: "1 repo" / "3 repos". */
export function formatRepoCount(count: number): string {
  return `${count} ${count === 1 ? "repo" : "repos"}`;
}
