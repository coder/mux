import { useRef, useEffect } from "react";
import dancingBlinkDarkSrc from "@/browser/assets/animations/dancing-blink-dark.webm";
import dancingBlinkLightSrc from "@/browser/assets/animations/dancing-blink-light.webm";
import { useTheme } from "@/browser/contexts/ThemeContext";

interface CreationCenterContentProps {
  projectName: string;
  isSending: boolean;
  /** The confirmed workspace name (null while generation is in progress) */
  workspaceName?: string | null;
  /** The confirmed workspace title (null while generation is in progress) */
  workspaceTitle?: string | null;
}

/**
 * Loading overlay displayed during workspace creation.
 * Shown as an overlay when isSending is true.
 */
export function CreationCenterContent(props: CreationCenterContentProps) {
  const { theme } = useTheme();
  const isDark = theme === "dark" || theme.endsWith("-dark");
  const videoSrc = isDark ? dancingBlinkDarkSrc : dancingBlinkLightSrc;

  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!props.isSending || !videoRef.current) {
      return;
    }

    videoRef.current.playbackRate = 1.3;
  }, [props.isSending, videoSrc]);

  return (
    <>
      {/*
        Preload the current theme's creation animation while idle so the loading overlay starts
        animating immediately as soon as workspace creation begins.
      */}
      {!props.isSending && (
        <video
          className="pointer-events-none absolute h-0 w-0 opacity-0"
          src={videoSrc}
          preload="auto"
          muted
          playsInline
          aria-hidden="true"
        />
      )}

      {props.isSending && (
        <div
          className={`absolute inset-0 z-10 flex flex-col items-center justify-center pb-[30vh] ${isDark ? "bg-sidebar" : "bg-white"}`}
        >
          <video
            ref={videoRef}
            className="h-[50vh] w-[50vw] object-contain"
            src={videoSrc}
            preload="auto"
            autoPlay
            loop
            muted
            playsInline
          />
          <div className="-mt-32 max-w-xl px-8 text-center">
            <h2 className="text-foreground mb-2 text-2xl font-medium">Creating workspace</h2>
            <p className="text-muted text-sm leading-relaxed">
              {props.workspaceName ? (
                <>
                  <code className="bg-separator rounded px-1">{props.workspaceName}</code>
                  {props.workspaceTitle && (
                    <span className="text-muted-foreground ml-1">— {props.workspaceTitle}</span>
                  )}
                </>
              ) : (
                "Generating name…"
              )}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
