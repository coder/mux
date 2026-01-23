/**
 * useMobileKeyboardFix
 *
 * iOS Safari has a known issue where the visual viewport can remain scrolled
 * after the virtual keyboard dismisses. This leaves fixed-position elements
 * (like our mobile header) appearing offset from their intended position.
 *
 * This hook listens for visual viewport resize events (which fire when the
 * keyboard opens/closes) and resets window scroll when the viewport height
 * increases (keyboard closing).
 *
 * Only active on mobile touch devices where this bug occurs.
 */
import { useEffect } from "react";

export function useMobileKeyboardFix(): void {
  useEffect(() => {
    // Only apply fix on mobile touch devices
    const isMobileTouch =
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 768px) and (pointer: coarse)").matches;

    if (!isMobileTouch || !window.visualViewport) {
      return;
    }

    const vv = window.visualViewport;
    let lastHeight = vv.height;

    const handleResize = () => {
      const currentHeight = vv.height;

      // When viewport height increases significantly (keyboard closing),
      // reset scroll position to fix the offset header issue
      if (currentHeight > lastHeight + 50) {
        // Use requestAnimationFrame to ensure DOM has settled
        requestAnimationFrame(() => {
          // Scroll the window to top to reset any viewport offset
          window.scrollTo(0, 0);
        });
      }

      lastHeight = currentHeight;
    };

    vv.addEventListener("resize", handleResize);

    return () => {
      vv.removeEventListener("resize", handleResize);
    };
  }, []);
}
