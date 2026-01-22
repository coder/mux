const GENERIC_FONT_FAMILIES: ReadonlySet<string> = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
]);

export const TERMINAL_ICON_FALLBACK_FAMILY = "Nerd Font Symbols";

export function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

export function splitFontFamilyList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function isGenericFontFamily(value: string): boolean {
  return GENERIC_FONT_FAMILIES.has(value.trim().toLowerCase());
}

export function quoteCssFontFamily(value: string): string {
  const trimmed = stripOuterQuotes(value);
  if (!trimmed) {
    return trimmed;
  }

  if (isGenericFontFamily(trimmed)) {
    return trimmed;
  }

  // Quote names containing whitespace or punctuation that would confuse CSS parsing.
  //
  // If the name itself contains quotes, strip them. A font-family name containing literal
  // quotes is almost certainly user input error and would produce invalid CSS.
  if (/[^a-zA-Z0-9_-]/.test(trimmed)) {
    const sanitized = trimmed.replace(/"/g, "");
    return `"${sanitized}"`;
  }

  return trimmed;
}

export function formatCssFontFamilyList(value: string): string {
  const parts = splitFontFamilyList(value);
  if (parts.length === 0) {
    return value.trim();
  }

  return parts.map(quoteCssFontFamily).join(", ");
}

export function appendTerminalIconFallback(fontFamily: string): string {
  const parts = splitFontFamilyList(fontFamily).map(stripOuterQuotes).filter(Boolean);
  const hasFallback = parts.some(
    (part) => part.trim().toLowerCase() === TERMINAL_ICON_FALLBACK_FAMILY.toLowerCase()
  );
  if (hasFallback) {
    return formatCssFontFamilyList(fontFamily);
  }

  const withFallback =
    parts.length === 0
      ? TERMINAL_ICON_FALLBACK_FAMILY
      : `${parts.join(", ")}, ${TERMINAL_ICON_FALLBACK_FAMILY}`;

  return formatCssFontFamilyList(withFallback);
}

export function getPrimaryFontFamily(value: string): string | undefined {
  const first = splitFontFamilyList(value).at(0);
  if (!first) {
    return undefined;
  }

  const stripped = stripOuterQuotes(first);
  return stripped || undefined;
}

const FONT_AVAILABILITY_TEST_STRING = "abcdefghijklmnopqrstuvwxyz0123456789";
const FONT_AVAILABILITY_BASE_FAMILIES = ["monospace", "serif", "sans-serif"] as const;

export function isFontFamilyAvailableInBrowser(family: string, fontSize: number): boolean {
  if (typeof document === "undefined") {
    return true;
  }

  const body = document.body;
  if (!body) {
    return true;
  }

  const span = document.createElement("span");
  span.textContent = FONT_AVAILABILITY_TEST_STRING;
  span.style.position = "absolute";
  span.style.left = "-9999px";
  span.style.top = "-9999px";
  span.style.fontSize = `${fontSize}px`;
  span.style.fontVariant = "normal";
  span.style.fontStyle = "normal";
  span.style.fontWeight = "400";
  span.style.letterSpacing = "0";
  span.style.whiteSpace = "nowrap";
  body.appendChild(span);

  try {
    const baselineWidths = new Map<string, number>();

    for (const baseFamily of FONT_AVAILABILITY_BASE_FAMILIES) {
      span.style.fontFamily = baseFamily;
      baselineWidths.set(baseFamily, span.offsetWidth);
    }

    for (const baseFamily of FONT_AVAILABILITY_BASE_FAMILIES) {
      span.style.fontFamily = `${quoteCssFontFamily(family)}, ${baseFamily}`;

      const baseline = baselineWidths.get(baseFamily);
      if (baseline === undefined) {
        continue;
      }

      if (span.offsetWidth !== baseline) {
        return true;
      }
    }

    return false;
  } finally {
    span.remove();
  }
}
