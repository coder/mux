import { useTheme } from "@/browser/contexts/ThemeContext";
import { Shimmer } from "@/browser/components/ai-elements/shimmer";
import { LoadingAnimation } from "@/browser/components/LoadingAnimation";

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

  return (
    <>
      {props.isSending && (
        <div
          className={`absolute inset-0 z-10 flex flex-col items-center justify-center pb-[30vh] ${isDark ? "bg-sidebar" : "bg-white"}`}
        >
          <LoadingAnimation />
          <div className="mt-8 max-w-xl px-8 text-center">
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
                <Shimmer>Generating name…</Shimmer>
              )}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
