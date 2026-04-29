import type { APIClient } from "@/browser/contexts/API";
import type { SkillResolutionTarget } from "@/browser/features/ChatInput/utils";
import { SkillNameSchema } from "@/common/orpc/schemas/agentSkill";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type { AgentSkillReference } from "@/common/types/message";
import { dedupeAgentSkillRefs } from "@/common/types/message";

/** Parser-only candidate. The startIndex/endIndex are autocomplete-replacement aids
 *  and MUST NOT be persisted in metadata (they become ambiguous after edits/reviews/etc.). */
export interface InlineSkillCandidate {
  skillName: string;
  startIndex: number;
  endIndex: number;
}

/** Active candidate when the cursor is inside a `$partial` token (used by autocomplete). */
export interface InlineSkillCursorMatch {
  partial: string;
  startIndex: number;
  endIndex: number;
}

interface TextRange {
  start: number;
  end: number;
}

const MIN_FENCE_MARKER_LENGTH = 3;
const MAX_FENCE_MARKER_INDENTATION = 3;
type FenceChar = "`" | "~";

interface FenceMarker {
  char: FenceChar;
  length: number;
  markerStart: number;
}

const LEFT_BOUNDARY_BLOCKED_RE = /[\w$]/;

function isSkillStartChar(ch: string | undefined): boolean {
  return Boolean(ch && ch >= "a" && ch <= "z");
}

function isSkillContinuationChar(ch: string | undefined): boolean {
  return Boolean(ch && ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "-"));
}

function hasSaneLeftBoundary(text: string, dollarIndex: number): boolean {
  if (dollarIndex === 0) {
    return true;
  }

  return !LEFT_BOUNDARY_BLOCKED_RE.test(text[dollarIndex - 1] ?? "");
}

function getCharRunLength(text: string, start: number, ch: string): number {
  let end = start;
  while (end < text.length && text[end] === ch) {
    end++;
  }

  return end - start;
}

function getBacktickRunLength(text: string, start: number): number {
  return getCharRunLength(text, start, "`");
}

function isFenceChar(ch: string | undefined): ch is FenceChar {
  return ch === "`" || ch === "~";
}

function isLineStart(text: string, index: number): boolean {
  return index === 0 || text[index - 1] === "\n" || text[index - 1] === "\r";
}

function getFenceMarkerAtLineStart(text: string, index: number): FenceMarker | null {
  if (!isLineStart(text, index)) {
    return null;
  }

  let markerStart = index;
  let indentation = 0;
  while (indentation < MAX_FENCE_MARKER_INDENTATION && text[markerStart] === " ") {
    markerStart++;
    indentation++;
  }

  const ch = text[markerStart];
  if (!isFenceChar(ch)) {
    return null;
  }

  const length = getCharRunLength(text, markerStart, ch);
  if (length < MIN_FENCE_MARKER_LENGTH) {
    return null;
  }

  return { char: ch, length, markerStart };
}

function findLineEnd(text: string, start: number): number {
  let end = start;
  while (end < text.length && text[end] !== "\n" && text[end] !== "\r") {
    end++;
  }

  return end;
}

function findNextLineStart(text: string, start: number): number {
  const lineEnd = findLineEnd(text, start);
  if (lineEnd >= text.length) {
    return text.length;
  }

  return text[lineEnd] === "\r" && text[lineEnd + 1] === "\n" ? lineEnd + 2 : lineEnd + 1;
}

function hasOnlySpacesOrTabsUntilLineEnd(text: string, start: number): boolean {
  const lineEnd = findLineEnd(text, start);
  for (let index = start; index < lineEnd; index++) {
    const ch = text[index];
    if (ch !== " " && ch !== "\t") {
      return false;
    }
  }

  return true;
}

function findInlineCodeEnd(text: string, start: number, delimiterLength: number): number | null {
  let index = start;
  while (index < text.length) {
    const ch = text[index];
    if (ch === "\n" || ch === "\r") {
      return null;
    }

    if (ch !== "`") {
      index++;
      continue;
    }

    const runLength = getBacktickRunLength(text, index);
    index += runLength;

    // Markdown inline code spans close only on the first backtick run of the same length.
    if (runLength === delimiterLength) {
      return index;
    }
  }

  return null;
}

function collectCodeRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  let index = 0;

  while (index < text.length) {
    const fenceMarker = getFenceMarkerAtLineStart(text, index);
    if (fenceMarker) {
      const fenceStart = index;
      index = findNextLineStart(text, index);

      while (index < text.length) {
        const closingFenceMarker = getFenceMarkerAtLineStart(text, index);
        if (
          closingFenceMarker &&
          closingFenceMarker.char === fenceMarker.char &&
          closingFenceMarker.length >= fenceMarker.length &&
          hasOnlySpacesOrTabsUntilLineEnd(
            text,
            closingFenceMarker.markerStart + closingFenceMarker.length
          )
        ) {
          index = closingFenceMarker.markerStart + closingFenceMarker.length;
          break;
        }

        index = findNextLineStart(text, index);
      }

      ranges.push({ start: fenceStart, end: index });
      continue;
    }

    const ch = text[index];
    if (ch === "\n" || ch === "\r") {
      index++;
      continue;
    }

    if (ch === "`") {
      const rangeStart = index;
      const delimiterLength = getBacktickRunLength(text, index);
      index += delimiterLength;

      const rangeEnd = findInlineCodeEnd(text, index, delimiterLength);
      if (rangeEnd !== null) {
        ranges.push({ start: rangeStart, end: rangeEnd });
        index = rangeEnd;
        continue;
      }

      if (delimiterLength > 1) {
        const lineEnd = findLineEnd(text, index);
        ranges.push({ start: rangeStart, end: lineEnd });
        index = lineEnd;
      }

      continue;
    }

    index++;
  }

  return ranges;
}

function isPositionInRange(position: number, range: TextRange): boolean {
  return position >= range.start && position < range.end;
}

function isCursorInsideCodeRange(cursor: number, range: TextRange): boolean {
  return cursor > range.start && cursor < range.end;
}

function isPartialToken(rawPartial: string): boolean {
  if (rawPartial.length === 0) {
    return true;
  }

  if (!isSkillStartChar(rawPartial[0])) {
    return false;
  }

  for (let index = 1; index < rawPartial.length; index++) {
    if (!isSkillContinuationChar(rawPartial[index])) {
      return false;
    }
  }

  return true;
}

export function extractInlineSkillReferenceCandidates(text: string): InlineSkillCandidate[] {
  if (!text.includes("$")) {
    return [];
  }

  const codeRanges = collectCodeRanges(text);
  const candidates: InlineSkillCandidate[] = [];
  let codeRangeIndex = 0;

  for (let index = 0; index < text.length; index++) {
    while (codeRangeIndex < codeRanges.length && index >= codeRanges[codeRangeIndex].end) {
      codeRangeIndex++;
    }

    const codeRange = codeRanges[codeRangeIndex];
    if (codeRange && isPositionInRange(index, codeRange)) {
      index = codeRange.end - 1;
      continue;
    }

    if (text[index] !== "$" || !hasSaneLeftBoundary(text, index)) {
      continue;
    }

    if (!isSkillStartChar(text[index + 1])) {
      continue;
    }

    let tokenEnd = index + 2;
    while (tokenEnd < text.length && isSkillContinuationChar(text[tokenEnd])) {
      tokenEnd++;
    }

    const rawTokenEnd = tokenEnd;
    let skillName = text.slice(index + 1, tokenEnd);
    if (skillName.endsWith("-")) {
      skillName = skillName.slice(0, -1);
      tokenEnd--;
    }

    if (SkillNameSchema.safeParse(skillName).success) {
      candidates.push({ skillName, startIndex: index, endIndex: tokenEnd });
    }

    index = rawTokenEnd - 1;
  }

  return candidates;
}

export function findInlineSkillReferenceAtCursor(
  text: string,
  cursor: number
): InlineSkillCursorMatch | null {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > text.length || !text.includes("$")) {
    return null;
  }

  const codeRanges = collectCodeRanges(text);
  if (codeRanges.some((range) => isCursorInsideCodeRange(cursor, range))) {
    return null;
  }

  let tokenStart = cursor;
  while (tokenStart > 0 && isSkillContinuationChar(text[tokenStart - 1])) {
    tokenStart--;
  }

  const dollarIndex = tokenStart > 0 && text[tokenStart - 1] === "$" ? tokenStart - 1 : -1;
  if (dollarIndex === -1 || !hasSaneLeftBoundary(text, dollarIndex)) {
    return null;
  }

  let tokenEnd = cursor;
  while (tokenEnd < text.length && isSkillContinuationChar(text[tokenEnd])) {
    tokenEnd++;
  }

  const partial = text.slice(dollarIndex + 1, tokenEnd);
  if (!isPartialToken(partial)) {
    return null;
  }

  return {
    partial,
    startIndex: dollarIndex,
    endIndex: tokenEnd,
  };
}

export interface InlineSkillResolveOptions {
  candidates: InlineSkillCandidate[];
  agentSkillDescriptors: AgentSkillDescriptor[];
  api: APIClient | null;
  discovery: SkillResolutionTarget | null;
}

async function resolveRemoteSkill(options: {
  skillName: string;
  api: APIClient;
  discovery: SkillResolutionTarget;
}): Promise<AgentSkillDescriptor | null> {
  try {
    const pkg =
      options.discovery.kind === "project"
        ? await options.api.agentSkills.get({
            projectPath: options.discovery.projectPath,
            skillName: options.skillName,
          })
        : await options.api.agentSkills.get({
            workspaceId: options.discovery.workspaceId,
            disableWorkspaceAgents: options.discovery.disableWorkspaceAgents,
            skillName: options.skillName,
          });

    return {
      name: pkg.frontmatter.name,
      description: pkg.frontmatter.description,
      scope: pkg.scope,
    };
  } catch {
    return null;
  }
}

export async function resolveInlineSkillReferences(
  options: InlineSkillResolveOptions
): Promise<AgentSkillReference[]> {
  if (options.candidates.length === 0) {
    return [];
  }

  const refs: AgentSkillReference[] = [];
  const seenSkillNames = new Set<string>();

  for (const candidate of options.candidates) {
    if (seenSkillNames.has(candidate.skillName)) {
      continue;
    }
    seenSkillNames.add(candidate.skillName);

    let skill = options.agentSkillDescriptors.find(
      (descriptor) => descriptor.name === candidate.skillName
    );

    if (!skill && options.api && options.discovery) {
      skill =
        (await resolveRemoteSkill({
          skillName: candidate.skillName,
          api: options.api,
          discovery: options.discovery,
        })) ?? undefined;
    }

    if (!skill) {
      continue;
    }

    refs.push({ skillName: skill.name, scope: skill.scope, source: "inline" });
  }

  return dedupeAgentSkillRefs(refs);
}
