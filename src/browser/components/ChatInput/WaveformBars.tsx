/**
 * Animated waveform bars for voice recording UI.
 * Shows 5 bars with staggered pulse animation.
 */

import { cn } from "@/common/lib/utils";

interface WaveformBarsProps {
  /** Color class for the bars (e.g., "bg-blue-500") */
  colorClass: string;
  /** Whether to mirror the animation (for right-side waveform) */
  mirrored?: boolean;
}

export const WaveformBars: React.FC<WaveformBarsProps> = (props) => {
  const indices = props.mirrored ? [4, 3, 2, 1, 0] : [0, 1, 2, 3, 4];

  return (
    <div className="flex items-center gap-1">
      {indices.map((i, displayIndex) => (
        <div
          key={displayIndex}
          className={cn("w-1 rounded-full", props.colorClass)}
          style={{
            height: `${12 + Math.sin(i * 0.8) * 8}px`,
            animation: `pulse 0.8s ease-in-out ${i * 0.1}s infinite alternate`,
          }}
        />
      ))}
    </div>
  );
};
