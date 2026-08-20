import ShuxLogoDark from "@/browser/assets/logos/shux-logo-dark.svg?react";
import ShuxLogoLight from "@/browser/assets/logos/shux-logo-light.svg?react";
import { useTheme } from "@/browser/contexts/ThemeContext";

export function LoadingScreen(props: { statusText?: string }) {
  const { theme } = useTheme();
  const ShuxLogo = theme === "dark" || theme.endsWith("-dark") ? ShuxLogoDark : ShuxLogoLight;

  // Keep the outer markup/classes in sync with index.html's boot loader so
  // the transition from the raw HTML placeholder to React is seamless.
  return (
    <div className="boot-loader" role="status" aria-live="polite" aria-busy="true">
      <div className="boot-loader__inner">
        <ShuxLogo className="boot-loader__logo" aria-hidden="true" />
        <p className="boot-loader__text">
          {props.statusText ?? "Loading Shux"}
          {/* Animated "..." dots — only for default text; custom statusText
              (e.g. "Reconnecting...") supplies its own punctuation. CSS in
              index.html drives the animation via boot-loader__dots::after. */}
          {!props.statusText && <span className="boot-loader__dots" />}
        </p>
      </div>
    </div>
  );
}
