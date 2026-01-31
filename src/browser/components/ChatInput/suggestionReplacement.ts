export interface SuggestionMatchRange {
  startIndex: number;
  endIndex: number;
}

export function applySuggestionReplacement(props: {
  input: string;
  match: SuggestionMatchRange;
  replacement: string;
  addTrailingSpace: boolean;
}): { nextInput: string; nextCursor: number } {
  const trailingSpace = props.addTrailingSpace ? " " : "";

  const nextInput =
    props.input.slice(0, props.match.startIndex) +
    props.replacement +
    trailingSpace +
    props.input.slice(props.match.endIndex);

  const nextCursor = props.match.startIndex + props.replacement.length + trailingSpace.length;

  return { nextInput, nextCursor };
}
