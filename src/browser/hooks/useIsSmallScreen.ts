import { useEffect, useState } from "react";
import { SMALL_SCREEN_MEDIA_QUERY } from "@/constants/layout";

export function useIsSmallScreen() {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return false;
    }

    return window.matchMedia(SMALL_SCREEN_MEDIA_QUERY).matches;
  });

  useEffect(() => {
    if (!window.matchMedia) {
      return;
    }

    const mql = window.matchMedia(SMALL_SCREEN_MEDIA_QUERY);
    const handleChange = (e: MediaQueryListEvent) => {
      setMatches(e.matches);
    };

    // Sync on mount in case the query changed between render and effect.
    setMatches(mql.matches);

    if (mql.addEventListener) {
      mql.addEventListener("change", handleChange);
      return () => mql.removeEventListener("change", handleChange);
    }

    // Safari < 14
    mql.addListener(handleChange);
    return () => mql.removeListener(handleChange);
  }, []);

  return matches;
}
