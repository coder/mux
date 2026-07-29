import { useChatTranscriptFullWidth } from "./useChatTranscriptFullWidth";

// The composer dock cancels the transcript scrollport's horizontal padding so it can paint
// full-bleed, so every surface inside it re-applies this gutter to land on the same left/right edge
// as transcript rows. Tailwind scans source text, so it has to be a literal class string.
export const CHAT_DOCK_GUTTER_CLASS = "px-[15px]";

/**
 * Width class for surfaces docked with the composer (the composer itself, its decorations, warning
 * banners) so they track the transcript column in both centered and full-width modes.
 */
export function useChatDockColumnWidthClass(): string {
  return useChatTranscriptFullWidth() ? "w-full" : "mx-auto w-full max-w-4xl";
}
