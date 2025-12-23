import { assert } from "@/common/utils/assert";

export interface PartialAgentReportArgsFromArgsText {
  /**
   * The decoded (best-effort) report markdown.
   *
   * This can be incomplete when the JSON args are still streaming.
   */
  reportMarkdown: string | null;
  /**
   * The decoded (best-effort) title.
   *
   * This can be incomplete when the JSON args are still streaming.
   */
  title: string | null;
}

function isAsciiWhitespace(char: string): boolean {
  // Keep fast + predictable (avoid regex for perf in tight loops).
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function decodePartialJsonString(argsText: string, startQuoteIndex: number): string {
  assert(
    startQuoteIndex >= 0 && startQuoteIndex < argsText.length,
    "decodePartialJsonString: startQuoteIndex out of range"
  );
  assert(argsText[startQuoteIndex] === '"', "decodePartialJsonString: expected opening quote");

  const out: string[] = [];
  const len = argsText.length;
  let i = startQuoteIndex + 1;

  while (i < len) {
    const c = argsText[i];

    if (c === '"') {
      // Closing quote.
      break;
    }

    if (c !== "\\") {
      out.push(c);
      i += 1;
      continue;
    }

    // Escape sequence.
    i += 1;
    if (i >= len) {
      // Truncated escape sequence (best-effort: ignore).
      break;
    }

    const esc = argsText[i];
    switch (esc) {
      case '"':
      case "\\":
      case "/": {
        out.push(esc);
        i += 1;
        break;
      }
      case "b": {
        out.push("\b");
        i += 1;
        break;
      }
      case "f": {
        out.push("\f");
        i += 1;
        break;
      }
      case "n": {
        out.push("\n");
        i += 1;
        break;
      }
      case "r": {
        out.push("\r");
        i += 1;
        break;
      }
      case "t": {
        out.push("\t");
        i += 1;
        break;
      }
      case "u": {
        // Unicode escape sequence: \uXXXX
        const remaining = len - (i + 1);
        if (remaining < 4) {
          // Truncated unicode escape. Stop decoding here.
          return out.join("");
        }

        const hex = argsText.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          // Malformed unicode escape. Best-effort: stop decoding.
          return out.join("");
        }

        out.push(String.fromCharCode(Number.parseInt(hex, 16)));
        i += 5;
        break;
      }
      default: {
        // Unknown escape. Best-effort: keep escaped char.
        out.push(esc);
        i += 1;
      }
    }
  }

  return out.join("");
}

function extractJsonStringValue(argsText: string, key: string): string | null {
  assert(typeof argsText === "string", "extractJsonStringValue: argsText must be a string");
  assert(key.length > 0, "extractJsonStringValue: key must be non-empty");

  // Streaming args are a JSON object encoded as text, e.g.
  // {"reportMarkdown":"...","title":"..."}
  //
  // We do a single pass to find a top-level string key token while skipping over
  // string literals to avoid false matches inside reportMarkdown content.
  const len = argsText.length;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < len; i++) {
    const c = argsText[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === "\\") {
        escaped = true;
        continue;
      }
      if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c !== '"') {
      continue;
    }

    // Start of a JSON string token.
    if (argsText.startsWith(key, i + 1) && argsText[i + 1 + key.length] === '"') {
      let j = i + 1 + key.length + 1;
      while (j < len && isAsciiWhitespace(argsText[j])) j += 1;
      if (j >= len || argsText[j] !== ":") {
        // Not a key token (could be inside a larger string, etc.).
        // Continue scanning.
        inString = true;
        escaped = false;
        continue;
      }
      j += 1;
      while (j < len && isAsciiWhitespace(argsText[j])) j += 1;
      if (j >= len || argsText[j] !== '"') {
        // Value isn't a string (or it's not present yet).
        return null;
      }

      return decodePartialJsonString(argsText, j);
    }

    // Not our key; skip over this string token.
    inString = true;
    escaped = false;
  }

  return null;
}

/**
 * Extract best-effort `agent_report` tool args from a partially streamed JSON args string.
 *
 * This is intentionally tolerant to truncated JSON and truncated escape sequences.
 */
export function extractAgentReportArgsFromArgsText(
  argsText: string
): PartialAgentReportArgsFromArgsText {
  assert(
    typeof argsText === "string",
    "extractAgentReportArgsFromArgsText: argsText must be a string"
  );

  return {
    reportMarkdown: extractJsonStringValue(argsText, "reportMarkdown"),
    title: extractJsonStringValue(argsText, "title"),
  };
}
