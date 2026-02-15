import thinkingDotsSvg from "@/browser/assets/animations/thinking-dots.svg?raw";
import { cn } from "@/common/lib/utils";
import { useId } from "react";

interface StreamingActivityIconProps {
  className?: string;
  shimmerColor: string;
  shimmerDurationSeconds: number;
}

type StreamingActivityIconStyle = React.CSSProperties &
  Record<"--shimmer-duration" | "--shimmer-color", string>;

function scopeStreamingSvgIds(svgMarkup: string, idPrefix: string): string {
  // The uploaded SVG contains many <animate href="#..."> links. Multiple instances of
  // identical IDs collide in the DOM, which can make later icons appear static.
  return svgMarkup.replaceAll('"_R_G', `"${idPrefix}_R_G`).replaceAll("#_R_G", `#${idPrefix}_R_G`);
}

/**
 * Animated streaming indicator used beside "...streaming" labels.
 * The shimmer overlay shares the same duration and color as the adjacent text.
 */
export function StreamingActivityIcon(props: StreamingActivityIconProps) {
  const style: StreamingActivityIconStyle = {
    "--shimmer-duration": `${props.shimmerDurationSeconds}s`,
    "--shimmer-color": props.shimmerColor,
  };
  const iconId = useId().replaceAll(":", "");
  const scopedSvg = scopeStreamingSvgIds(thinkingDotsSvg, `mux_streaming_${iconId}`);

  return (
    <span
      className={cn(
        "streaming-activity-icon shimmer-surface inline-flex items-center justify-center",
        props.className
      )}
      style={style}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: scopedSvg }}
    />
  );
}
