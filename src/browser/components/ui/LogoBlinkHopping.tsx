import React, { useCallback, useEffect, useRef, useState } from "react";

import BlinkHopAnimated from "@/browser/assets/logos/blink-hop.png";
import BlinkHopStatic from "@/browser/assets/logos/blink-hop-static.png";
interface LogoBlinkHoppingProps {
  size?: number;
  animate?: boolean | "once";
  className?: string;
}

const ANIMATION_DURATION_MS = 3500;

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mediaQuery) return;

    const update = () => {
      setPrefersReducedMotion(mediaQuery.matches);
    };

    update();

    // Safari <= 13 uses addListener/removeListener
    mediaQuery.addEventListener?.("change", update);
    mediaQuery.addListener?.(update);

    return () => {
      mediaQuery.removeEventListener?.("change", update);
      mediaQuery.removeListener?.(update);
    };
  }, []);

  return prefersReducedMotion;
}

export const LogoBlinkHopping: React.FC<LogoBlinkHoppingProps> = ({
  size = 16,
  animate = false,
  className,
}) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const effectiveAnimate: LogoBlinkHoppingProps["animate"] = prefersReducedMotion ? false : animate;

  const [playing, setPlaying] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const startTimeRef = useRef<number | undefined>(undefined);

  const clearTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = undefined;
    }
  }, []);

  const stop = useCallback(() => {
    clearTimer();
    setPlaying(false);
    startTimeRef.current = undefined;
  }, [clearTimer]);

  const playOnce = useCallback(() => {
    if (playing) return;

    clearTimer();
    setPlaying(true);
    startTimeRef.current = Date.now();

    timeoutRef.current = setTimeout(stop, ANIMATION_DURATION_MS);
  }, [playing, clearTimer, stop]);

  const playContinuous = useCallback(() => {
    if (playing) return;

    clearTimer();
    setPlaying(true);
    startTimeRef.current = Date.now();

    const loop = () => {
      timeoutRef.current = setTimeout(() => {
        if (effectiveAnimate === true) {
          // Still want continuous animation
          startTimeRef.current = Date.now();
          loop();
          return;
        }

        stop();
      }, ANIMATION_DURATION_MS);
    };

    loop();
  }, [playing, clearTimer, effectiveAnimate, stop]);

  const stopGracefully = useCallback(() => {
    if (!playing || !startTimeRef.current) {
      stop();
      return;
    }

    clearTimer();

    const elapsed = Date.now() - startTimeRef.current;

    // If we're at a good stopping point (static frames), stop immediately
    if ((elapsed >= 1450 && elapsed <= 1550) || elapsed >= 3450) {
      stop();
      return;
    }

    // Otherwise wait for the next good stopping point
    if (elapsed < 1450) {
      timeoutRef.current = setTimeout(stop, 1500 - elapsed);
    } else if (elapsed < 3450) {
      timeoutRef.current = setTimeout(stop, ANIMATION_DURATION_MS - elapsed);
    }
  }, [playing, clearTimer, stop]);

  useEffect(() => {
    if (effectiveAnimate === false) {
      stopGracefully();
      return;
    }

    if (effectiveAnimate === "once") {
      playOnce();
      return;
    }

    playContinuous();
  }, [effectiveAnimate, playContinuous, playOnce, stopGracefully]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        position: "relative",
        overflow: "hidden",
      }}
    >
      <img
        src={playing ? BlinkHopAnimated : BlinkHopStatic}
        alt="Loading"
        width={size * 2}
        height={size * 2}
        className="dark:invert"
        style={{
          width: size * 3,
          height: size * 3,
          objectFit: "cover",
          transform: "translate(0%, -33.5%)",
        }}
      />
    </div>
  );
};
