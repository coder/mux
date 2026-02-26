import Lottie from "lottie-react";
import dancingBlinkAnimation from "@/browser/assets/animations/dancing-blink.json";
import { useTheme } from "@/browser/contexts/ThemeContext";

interface LoadingAnimationProps {
  className?: string;
}

/**
 * Shared loading animation used across all loading screens (workspace loading,
 * workspace creation, initial boot, etc.) for a consistent visual experience.
 * Renders the dancing-blink Lottie animation with automatic light/dark theme handling.
 */
export function LoadingAnimation(props: LoadingAnimationProps) {
  const { theme } = useTheme();
  const isDark = theme === "dark" || theme.endsWith("-dark");

  return (
    <Lottie
      animationData={dancingBlinkAnimation}
      loop
      renderer="svg"
      aria-hidden="true"
      className={`w-[150px] ${isDark ? "brightness-0 invert" : ""} ${props.className ?? ""}`}
    />
  );
}
