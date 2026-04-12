import React, { useEffect, useRef } from "react";

interface ElapsedTimeDisplayProps {
  startedAt: number | undefined;
  isActive: boolean;
}

/**
 * Shared elapsed time display for tool headers.
 * Keeps requestAnimationFrame + per-second updates at the leaf so parent tool calls do not re-render.
 */
export const ElapsedTimeDisplay: React.FC<ElapsedTimeDisplayProps> = ({ startedAt, isActive }) => {
  const elapsedRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);
  const baseStart = useRef(startedAt ?? Date.now());

  useEffect(() => {
    if (!isActive) {
      elapsedRef.current = 0;
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      return;
    }

    baseStart.current = startedAt ?? Date.now();
    let lastSecond = -1;

    const tick = () => {
      const now = Date.now();
      const elapsed = now - baseStart.current;
      const currentSecond = Math.floor(elapsed / 1000);

      // Only update when second changes to minimize renders
      if (currentSecond !== lastSecond) {
        lastSecond = currentSecond;
        elapsedRef.current = elapsed;
        forceUpdate();
      }

      frameRef.current = requestAnimationFrame(tick);
    };

    tick();

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [isActive, startedAt]);

  if (!isActive || elapsedRef.current === 0) {
    return null;
  }

  return <> • {Math.round(elapsedRef.current / 1000)}s</>;
};
