import { useState, useEffect } from "react";
import MuxLogoDark from "@/browser/assets/logos/mux-logo-dark.svg?react";

const LOADING_PHRASES = [
  "Parallelizing agents…",
  "Muxing everything…",
  "Spinning up workspaces…",
  "Negotiating with git…",
  "Warming up the multiplexers…",
  "Almost there…",
];

export function LoadingScreen() {
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [opacity, setOpacity] = useState(1);

  useEffect(() => {
    // Check for reduced motion preference
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mediaQuery.matches) return;

    const interval = setInterval(() => {
      setOpacity(0);
      setTimeout(() => {
        setPhraseIndex((prev) => (prev + 1) % LOADING_PHRASES.length);
        setOpacity(1);
      }, 150);
    }, 1500);

    return () => clearInterval(interval);
  }, []);

  return (
    <div
      className="bg-background flex h-screen w-screen items-center justify-center"
      data-testid="LoadingScreen"
    >
      <div className="flex flex-col items-center gap-6">
        {/* Logo with shimmer */}
        <div className="relative h-[62px] w-[135px] overflow-hidden">
          <MuxLogoDark className="block h-full w-full" />
          <div
            className="pointer-events-none absolute inset-0 animate-[shimmer-slide_2.5s_infinite_linear] motion-reduce:animate-none"
            style={{
              background:
                "linear-gradient(90deg, transparent 0%, transparent 40%, hsla(207 100% 60% / 0.35) 50%, transparent 60%, transparent 100%)",
              width: "300%",
              marginLeft: "-180%",
            }}
          />
        </div>
        {/* Rotating loading text */}
        <p
          className="text-text-secondary min-w-[28ch] text-center text-sm transition-opacity duration-150"
          style={{ opacity }}
        >
          {LOADING_PHRASES[phraseIndex]}
        </p>
      </div>
    </div>
  );
}
