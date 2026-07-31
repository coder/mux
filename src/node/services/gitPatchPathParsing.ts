/**
 * Parsers for file paths in git patch text. Git quotes paths containing
 * "unusual" bytes (C-style, octal escapes) but leaves ordinary spaces
 * unquoted, so naive whitespace splitting misreads `diff --git` headers.
 * Shared by the workflow allowlist validation and the apply-tool preflight;
 * both must over-approximate (extra candidate paths are safe, missed paths
 * are not).
 */

export interface GitStatusPorcelainEntry {
  path: string;
  status: string;
}

/**
 * Parses `git status --porcelain -z` records. NUL termination keeps exotic
 * paths unquoted; rename/copy records carry the source path as a second
 * NUL-separated field.
 */
export function parseGitStatusPorcelainZ(stdout: string): GitStatusPorcelainEntry[] {
  const entriesByPath: GitStatusPorcelainEntry[] = [];
  const entries = stdout.split("\0");
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.length < 4) continue;

    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (filePath.length > 0) {
      entriesByPath.push({ path: filePath, status });
    }

    if (status.includes("R") || status.includes("C")) {
      i += 1;
      const sourcePath = entries[i];
      if (sourcePath != null && sourcePath.length > 0) {
        entriesByPath.push({ path: sourcePath, status });
      }
    }
  }
  return entriesByPath;
}

export function parseDiffGitHeaderPaths(stdout: string): string[] {
  const paths = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("diff --git ")) continue;
    for (const filePath of parseDiffGitHeaderLine(line.slice("diff --git ".length))) {
      paths.add(filePath);
    }
  }
  return [...paths].filter((filePath) => filePath.length > 0);
}

/**
 * Parses `a/<old> b/<new>` with `diff --git ` already removed. Unquoted paths
 * may contain spaces, making the split point ambiguous; every candidate split
 * is returned so callers over-approximate rather than miss a path.
 */
export function parseDiffGitHeaderLine(line: string): string[] {
  if (line.startsWith('"')) {
    const first = parseGitQuotedPath(line, 0);
    if (first == null) return [];
    let secondStartOffset = first.nextOffset;
    while (line[secondStartOffset] === " ") {
      secondStartOffset += 1;
    }
    // Git quotes each side independently, so a quoted source can pair with an
    // unquoted destination (which may itself contain spaces).
    const rest = line.slice(secondStartOffset);
    const second = rest.startsWith('"') ? parseGitQuotedPath(line, secondStartOffset)?.path : rest;
    return [stripDiffPathPrefix(first.path), stripDiffPathPrefix(second)].filter(
      (filePath): filePath is string => filePath != null && filePath.length > 0
    );
  }

  if (!line.startsWith("a/")) {
    return [];
  }

  const paths = new Set<string>();
  let separatorIndex = line.indexOf(" b/", "a/".length);
  while (separatorIndex !== -1) {
    paths.add(line.slice("a/".length, separatorIndex));
    paths.add(line.slice(separatorIndex + " b/".length));
    separatorIndex = line.indexOf(" b/", separatorIndex + 1);
  }
  // Git quotes each side independently, so an unquoted source can pair with
  // a quoted destination (e.g. a rename onto a name needing C-quoting).
  // Every candidate quote start is tried, over-approximating like the
  // separator loop above.
  let quoteIndex = line.indexOf(' "', "a/".length);
  while (quoteIndex !== -1) {
    const second = parseGitQuotedPath(line, quoteIndex + 1);
    if (second != null) {
      const source = line.slice("a/".length, quoteIndex);
      const destination = stripDiffPathPrefix(second.path);
      if (source.length > 0) {
        paths.add(source);
      }
      if (destination != null && destination.length > 0) {
        paths.add(destination);
      }
    }
    quoteIndex = line.indexOf(' "', quoteIndex + 1);
  }
  return [...paths];
}

export function stripDiffPathPrefix(filePath: string | undefined): string | undefined {
  if (filePath == null) return undefined;
  return filePath.startsWith("a/") || filePath.startsWith("b/") ? filePath.slice(2) : filePath;
}

export function parsePatchMetadataPath(value: string): string {
  if (!value.startsWith('"')) {
    return value;
  }
  return parseGitQuotedPath(value, 0)?.path ?? "";
}

export function parseGitQuotedPath(
  value: string,
  startOffset: number
): { path: string; nextOffset: number } | undefined {
  if (value[startOffset] !== '"') {
    return undefined;
  }

  const bytes: number[] = [];
  const encoder = new TextEncoder();
  let offset = startOffset + 1;
  while (offset < value.length) {
    const char = value[offset];
    if (char === '"') {
      return { path: new TextDecoder().decode(Uint8Array.from(bytes)), nextOffset: offset + 1 };
    }

    if (char !== "\\") {
      const codePoint = value.codePointAt(offset);
      if (codePoint == null) {
        return undefined;
      }
      const codePointString = String.fromCodePoint(codePoint);
      bytes.push(...encoder.encode(codePointString));
      offset += codePointString.length;
      continue;
    }

    offset += 1;
    if (offset >= value.length) {
      return undefined;
    }

    const escaped = value[offset];
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      offset += 1;
      while (offset < value.length && octal.length < 3 && /[0-7]/.test(value[offset])) {
        octal += value[offset];
        offset += 1;
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }

    const escapedByte = decodeGitQuotedEscapedByte(escaped);
    if (escapedByte == null) {
      bytes.push(...encoder.encode(escaped));
    } else {
      bytes.push(escapedByte);
    }
    offset += 1;
  }

  return undefined;
}

function decodeGitQuotedEscapedByte(char: string): number | undefined {
  switch (char) {
    case "a":
      return 0x07;
    case "b":
      return 0x08;
    case "t":
      return 0x09;
    case "n":
      return 0x0a;
    case "v":
      return 0x0b;
    case "f":
      return 0x0c;
    case "r":
      return 0x0d;
    case '"':
      return 0x22;
    case "\\":
      return 0x5c;
    default:
      return undefined;
  }
}
