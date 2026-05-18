/**
 * Canonical user-facing budget parser shared by every goal-creation entry
 * point (`/goal budget`, GoalTab inline editor, command palette goal
 * creation). Three parsers used to live independently and drifted:
 *
 *   - `parseGoalBudgetCents` (slash command) required a `$` prefix
 *   - `parseBudgetInput` (GoalTab) accepted bare numbers
 *   - The command palette had a third copy with its own behavior
 *
 * `5.00` worked in the GoalTab but `/goal budget 5.00` returned an invalid
 * args error — Coder-agents-review P3 DEREM-21.
 *
 * Returns:
 *   - `null` when the input is empty (= "no budget" / clear budget)
 *   - a non-negative integer (cents) on valid dollar/cents input
 *   - `undefined` on invalid input
 *
 * Accepts (case-insensitive):
 *   - "" / whitespace → null
 *   - "5", "5.00", "$5", "$5.00" → 500
 *   - "5.25", "$5.25" → 525
 *   - "1c", "100c", "1C" → 1, 100, 1
 *   - any other input → undefined
 */
export function parseGoalBudgetInputCents(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const centsMatch = /^(\d+)c$/i.exec(trimmed);
  if (centsMatch) {
    return Number(centsMatch[1]);
  }

  const dollarsMatch = /^\$?(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!dollarsMatch) {
    return undefined;
  }

  const dollars = Number(dollarsMatch[1]);
  const cents = Number((dollarsMatch[2] ?? "").padEnd(2, "0"));
  return dollars * 100 + cents;
}

/**
 * Canonical user-facing turn-cap parser. Matches the strict-int semantics
 * of `GoalTab`'s legacy `parseTurnCapInput` so every entry point (`/goal
 * budget`, GoalTab inline editor, GoalBoard Adder, GoalBoard inline
 * editor) accepts the same set of inputs. Partial strings like `1.5` or
 * `12abc` correctly fail validation here, unlike `Number.parseInt` which
 * would have silently truncated to `1` / `12`.
 *
 * Returns:
 *   - `null` when the input is empty (= "no cap" / clear cap)
 *   - a positive integer on valid input
 *   - `undefined` on invalid input
 */
export function parseGoalTurnCapInput(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
