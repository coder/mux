/**
 * Shimmer placeholder shown while the transcript hydrates.
 *
 * Mimics the shape of a few conversation turns (a short user bubble + assistant
 * prose lines) using the shared shimmer `Skeleton`, so the loading state reads as
 * "messages are arriving" rather than a generic centered spinner. Turns fade out
 * toward the bottom to suggest more content below. It is top-aligned (not
 * vertically centered) and uses normal transcript flow so it occupies the same
 * place the real messages will, avoiding a jump when hydration completes.
 */
import { Skeleton } from "@/browser/components/Skeleton/Skeleton";

// Decreasing opacity per turn produces the trailing fade characteristic of
// skeleton loaders without an extra mask layer.
const TURNS: ReadonlyArray<{ opacity: number; assistantLineWidths: readonly string[] }> = [
  { opacity: 1, assistantLineWidths: ["w-[92%]", "w-[80%]", "w-[58%]"] },
  { opacity: 0.65, assistantLineWidths: ["w-[85%]", "w-[64%]"] },
  { opacity: 0.4, assistantLineWidths: ["w-[78%]", "w-[52%]"] },
];

export function TranscriptHydrationSkeleton() {
  return (
    <div
      data-testid="transcript-hydration-placeholder"
      role="status"
      aria-busy="true"
      aria-label="Loading transcript"
      className="flex flex-col gap-8 py-6 select-none"
    >
      {TURNS.map((turn, turnIndex) => (
        <div key={turnIndex} className="flex flex-col gap-4" style={{ opacity: turn.opacity }}>
          {/* User message: a short, right-aligned bubble. */}
          <Skeleton
            variant="shimmer"
            className="ml-auto block h-8 w-1/2 max-w-[16rem] rounded-lg"
          />
          {/* Assistant message: a left-aligned stack of prose lines of varied width. */}
          <div className="flex flex-col gap-2.5">
            {turn.assistantLineWidths.map((width, lineIndex) => (
              <Skeleton
                key={lineIndex}
                variant="shimmer"
                className={`block h-3.5 rounded ${width}`}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
