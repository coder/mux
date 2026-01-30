import type { MuxDeepLinkPayload } from "@/common/types/deepLink";

function getNonEmptySearchParam(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  if (!value) return undefined;
  return value;
}

/**
 * Parse a mux:// deep link into a typed payload.
 *
 * Currently supported route:
 * - mux://chat/new
 */
export function parseMuxDeepLink(raw: string): MuxDeepLinkPayload | null {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== "mux:") {
    return null;
  }

  if (url.hostname !== "chat" || url.pathname !== "/new") {
    return null;
  }

  const projectPath = getNonEmptySearchParam(url, "projectPath");
  const projectId = getNonEmptySearchParam(url, "projectId");
  const prompt = getNonEmptySearchParam(url, "prompt");
  const sectionId = getNonEmptySearchParam(url, "sectionId");

  return {
    type: "new_chat",
    ...(projectPath ? { projectPath } : {}),
    ...(projectId ? { projectId } : {}),
    ...(prompt ? { prompt } : {}),
    ...(sectionId ? { sectionId } : {}),
  };
}
