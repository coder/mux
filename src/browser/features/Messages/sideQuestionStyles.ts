/**
 * Shared visual treatment for the persisted /btw Q/A pair. The normal user
 * and assistant bubbles stay intact; these classes add only a light left
 * stripe, paired spacing, and the single "Side question" header.
 */
const SIDE_QUESTION_STRIPE = "border-l border-muted/30 pl-3 ml-1";

/** MessageWindow margins are owned by the side-branch wrapper for paired spacing. */
export const SIDE_QUESTION_MESSAGE_WINDOW_CLASS = "!mt-0 !mb-0";

/**
 * Visual treatment for the user-side /btw question row.
 *
 * `mb-0` collapses the bottom margin so the assistant answer tucks flush
 * against this row — tailwind-merge will resolve this against the default
 * `mb-1` / `mb-4` baked into MessageWindow.
 */
export const SIDE_QUESTION_USER_BLOCK_CLASS = `${SIDE_QUESTION_STRIPE} mt-4 mb-0`;

/**
 * Visual treatment for the assistant-side /btw answer row.
 *
 * `mt-0` overrides MessageWindow's default `mt-4` so the answer abuts the
 * user question above with no visible gap. The bottom margin is left to
 * MessageWindow (default mb-1 / settled mb-4) so the side branch still
 * has breathing room before the next main-agent turn.
 */
export const SIDE_QUESTION_ANSWER_BLOCK_CLASS = `${SIDE_QUESTION_STRIPE} mt-0`;

/**
 * Tailwind classes for the small uppercase "Side question" header label
 * that introduces the side-branch user bubble.
 *
 * The header is placed BEFORE the MessageWindow so it can introduce the
 * bubble — MessageWindow's existing `label` slot only renders into its
 * bottom meta row, which is the wrong affordance here (we want a header,
 * not a footer caption).
 */
export const SIDE_QUESTION_HEADER_CLASS =
  "text-muted mb-1 flex items-center gap-1 text-[10px] font-medium tracking-wide uppercase";
