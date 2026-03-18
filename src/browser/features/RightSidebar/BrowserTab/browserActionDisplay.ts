import assert from "@/common/utils/assert";
import type { BrowserAction } from "@/common/types/browserSession";

export type BrowserActionTypeLabel = BrowserAction["type"] | "scroll";

export interface ActionDisplayInfo {
  primaryText: string;
  secondaryText?: string;
  typeLabel: BrowserActionTypeLabel;
}

interface NavigateActionMetadata {
  previousUrl: string | null;
  currentUrl: string | null;
  previousTitle: string | null;
  title: string | null;
  navigateCount: number;
}

function getDefaultNavigateActionMetadata(): NavigateActionMetadata {
  return {
    previousUrl: null,
    currentUrl: null,
    previousTitle: null,
    title: null,
    navigateCount: 1,
  };
}

export function getActionDisplayInfo(action: BrowserAction): ActionDisplayInfo {
  const typeLabel = getBrowserActionTypeLabel(action);

  if (action.type !== "navigate") {
    return {
      primaryText: action.description,
      typeLabel,
    };
  }

  return getNavigateDisplayInfo(action, typeLabel);
}

export function getBrowserActionTypeLabel(action: BrowserAction): BrowserActionTypeLabel {
  if (action.type !== "custom" || action.metadata?.inputKind !== "scroll") {
    return action.type;
  }

  return "scroll";
}

function getNavigateDisplayInfo(
  action: BrowserAction,
  typeLabel: BrowserActionTypeLabel
): ActionDisplayInfo {
  const metadata = getNavigateActionMetadata(action);

  if (metadata.title != null && !looksLikeUrl(metadata.title)) {
    const host = getUrlHost(metadata.currentUrl);
    return {
      primaryText: appendNavigateCount(metadata.title, metadata.navigateCount),
      secondaryText: host ?? undefined,
      typeLabel,
    };
  }

  if (metadata.currentUrl != null) {
    const formattedUrl = formatNavigateUrl(metadata.currentUrl);
    if (formattedUrl != null) {
      return {
        primaryText: appendNavigateCount(formattedUrl, metadata.navigateCount),
        typeLabel,
      };
    }
  }

  return {
    primaryText: appendNavigateCount(action.description, metadata.navigateCount),
    typeLabel,
  };
}

function getNavigateActionMetadata(action: BrowserAction): NavigateActionMetadata {
  assert(
    action.type === "navigate",
    "navigate action metadata should only be read for navigate actions"
  );

  const metadata = action.metadata;
  if (metadata == null) {
    return getDefaultNavigateActionMetadata();
  }

  if (!isRecord(metadata)) {
    // Renderer formatting must self-heal around corrupted or forward-incompatible payloads so
    // one bad action cannot take down the entire Recent Actions panel.
    return getDefaultNavigateActionMetadata();
  }

  return {
    previousUrl: readOptionalMetadataString(metadata, "previousUrl"),
    currentUrl: readOptionalMetadataString(metadata, "currentUrl"),
    previousTitle: readOptionalMetadataString(metadata, "previousTitle"),
    title: readOptionalMetadataString(metadata, "title"),
    navigateCount: readNavigateCount(metadata),
  };
}

function readOptionalMetadataString(
  metadata: Record<string, unknown>,
  key: keyof Omit<NavigateActionMetadata, "navigateCount">
): string | null {
  const value = metadata[key];
  if (typeof value !== "string") {
    // Display labels should degrade gracefully when stored metadata is malformed instead of
    // crashing the renderer on bad or newer-than-expected payload shapes.
    return null;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : null;
}

function readNavigateCount(metadata: Record<string, unknown>): number {
  const navigateCount = metadata.navigateCount;
  if (typeof navigateCount !== "number" || !Number.isInteger(navigateCount) || navigateCount < 1) {
    // Same resilience rule as string fields: recent-action formatting should recover from
    // malformed metadata instead of letting one bad entry break the whole panel.
    return 1;
  }

  return navigateCount;
}

function appendNavigateCount(primaryText: string, navigateCount: number): string {
  assert(
    Number.isInteger(navigateCount) && navigateCount >= 1,
    "navigate action counts must stay positive integers"
  );
  return navigateCount === 1 ? primaryText : `${primaryText} ×${navigateCount}`;
}

function formatNavigateUrl(url: string): string | null {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.host.length === 0) {
      return parsedUrl.href.length > 0 ? parsedUrl.href : null;
    }

    const pathname = parsedUrl.pathname === "/" ? "" : parsedUrl.pathname;
    return `${parsedUrl.host}${pathname}`;
  } catch {
    return null;
  }
}

function getUrlHost(url: string | null): string | null {
  if (url == null) {
    return null;
  }

  try {
    const parsedUrl = new URL(url);
    return parsedUrl.host.length > 0 ? parsedUrl.host : null;
  } catch {
    return null;
  }
}

function looksLikeUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
