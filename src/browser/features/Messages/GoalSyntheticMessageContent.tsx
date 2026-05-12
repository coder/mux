import type { ReactElement } from "react";
import { CircleStop, Target } from "lucide-react";
import { unescapeXml } from "@/common/utils/xml";
import { GOAL_OBJECTIVE_CLOSE_TAG, GOAL_OBJECTIVE_OPEN_TAG } from "@/constants/goals";

type GoalCardVariant = "continuation" | "budget-limit";

interface GoalSyntheticMessageContentProps {
  content: string;
  kind: GoalCardVariant;
}

const FIRST_PARAGRAPH_DELIMITER = "\n\n";
const MAX_LIMIT_REASON_LENGTH = 160;

function extractObjective(content: string): string | null {
  const objectiveStart = content.indexOf(GOAL_OBJECTIVE_OPEN_TAG);
  if (objectiveStart === -1) return null;

  const valueStart = objectiveStart + GOAL_OBJECTIVE_OPEN_TAG.length;
  const objectiveEnd = content.indexOf(GOAL_OBJECTIVE_CLOSE_TAG, valueStart);
  if (objectiveEnd === -1) return null;

  const objective = content.slice(valueStart, objectiveEnd).trim();
  return objective.length > 0 ? unescapeXml(objective) : null;
}

function extractFirstParagraph(content: string): string | null {
  const delimiterIndex = content.indexOf(FIRST_PARAGRAPH_DELIMITER);
  if (delimiterIndex === -1) return null;

  const paragraph = content.slice(0, delimiterIndex).trim();
  if (!paragraph) return null;
  if (paragraph.length > MAX_LIMIT_REASON_LENGTH) return null;
  if (paragraph.includes(GOAL_OBJECTIVE_OPEN_TAG)) return null;

  return paragraph;
}

/** Hides model-only goal prompt internals while surfacing the user-facing goal event. */
export function GoalSyntheticMessageContent(props: GoalSyntheticMessageContentProps): ReactElement {
  const objective = extractObjective(props.content);
  let title = "Continuing active goal";
  let description = "Mux is taking the next step automatically.";
  let Icon: typeof Target = Target;

  if (props.kind === "budget-limit") {
    title = "Goal limit reached";
    description = extractFirstParagraph(props.content) ?? "Mux is wrapping up the current goal.";
    Icon = CircleStop;
  }

  return (
    <section className="bg-muted/10 max-w-[42rem] min-w-[18rem] rounded-md border border-[var(--color-user-border)] p-3 not-italic">
      <div className="flex items-start gap-3">
        <div className="bg-muted/20 text-muted mt-0.5 rounded-md p-1.5">
          <Icon aria-hidden="true" className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <div className="text-sm font-medium text-[var(--color-user-text)]">{title}</div>
            <div className="text-muted mt-0.5 text-xs">{description}</div>
          </div>
          {objective && (
            <blockquote className="border-l-2 border-[var(--color-user-border)] pl-3 text-sm leading-relaxed whitespace-pre-wrap text-[var(--color-user-text)]">
              {objective}
            </blockquote>
          )}
        </div>
      </div>
    </section>
  );
}
