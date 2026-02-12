import ThinkingDots from "@/browser/assets/animations/thinking-dots.svg?react";
import { cn } from "@/common/lib/utils";

interface StreamingActivityIconProps {
  className?: string;
  shimmerColor: string;
  shimmerDurationSeconds: number;
}

type StreamingActivityIconStyle = React.CSSProperties &
  Record<"--shimmer-duration" | "--shimmer-color", string>;

/**
 * Animated streaming indicator used beside "...streaming" labels.
 * The shimmer overlay shares the same duration and color as the adjacent text.
 */
export function StreamingActivityIcon(props: StreamingActivityIconProps) {
  const style: StreamingActivityIconStyle = {
    "--shimmer-duration": `${props.shimmerDurationSeconds}s`,
    "--shimmer-color": props.shimmerColor,
  };

  return (
    <span
      className={cn("shimmer-surface inline-flex items-center justify-center", props.className)}
      style={style}
      aria-hidden
    >
      <ThinkingDots className="size-full fill-current" />
    </span>
  );
}
