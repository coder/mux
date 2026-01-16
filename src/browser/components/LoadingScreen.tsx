import { useEffect, useState } from "react";
import { useTheme } from "@/browser/contexts/ThemeContext";
import MuxLogoDark from "@/browser/assets/logos/mux-logo-dark.svg?react";
import MuxLogoLight from "@/browser/assets/logos/mux-logo-light.svg?react";
import muxLogoMaskUrl from "@/browser/assets/logos/mux-logo-dark.svg";

const LOADING_PHRASES = [
  "Parallelizing agents…",
  "Muxing everything…",
  "Spinning up workspaces…",
  "Negotiating with git…",
  "Warming up the multiplexers…",
  "Almost there…",
];

export function LoadingScreen() {
  const { theme } = useTheme();
  const MuxLogo = theme === "dark" || theme === "flexoki-dark" ? MuxLogoDark : MuxLogoLight;

  const [phraseIndex, setPhraseIndex] = useState(0);
  const [opacity, setOpacity] = useState(1);
  const [prefersReducedMotion] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  });

  useEffect(() => {
    if (prefersReducedMotion) {
      return;
    }

    const interval = setInterval(() => {
      setOpacity(0);
      setTimeout(() => {
        setPhraseIndex((prev) => (prev + 1) % LOADING_PHRASES.length);
        setOpacity(1);
      }, 150);
    }, 1500);

    return () => clearInterval(interval);
  }, [prefersReducedMotion]);

  return (
    <div
      className="bg-background flex h-screen w-screen items-center justify-center"
      data-testid="LoadingScreen"
    >
      <div className="flex flex-col items-center gap-6">
        <div className="relative h-[62px] w-[135px]">
          <MuxLogo className="block h-full w-full" />

          {!prefersReducedMotion && (
            <div
              className="pointer-events-none absolute inset-0"
              data-chromatic="ignore"
              style={{
                WebkitMaskImage: `url(${muxLogoMaskUrl})`,
                WebkitMaskRepeat: "no-repeat",
                WebkitMaskPosition: "center",
                WebkitMaskSize: "contain",
                maskImage: `url(${muxLogoMaskUrl})`,
                maskRepeat: "no-repeat",
                maskPosition: "center",
                maskSize: "contain",
                background:
                  "linear-gradient(90deg, transparent 0%, transparent 35%, color-mix(in srgb, var(--color-foreground) 25%, black) 50%, transparent 65%, transparent 100%)",
                backgroundSize: "300% 100%",
                animation: "shimmer-text-sweep 2s steps(42, end) infinite",
              }}
            />
          )}
        </div>

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
