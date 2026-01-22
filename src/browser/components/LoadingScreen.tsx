import { AlertTriangle } from "lucide-react";
import { Button } from "@/browser/components/ui/button";
import { ErrorMessage } from "@/browser/components/ErrorMessage";

interface LoadingScreenError {
  title: string;
  message: string;
}

interface LoadingScreenProps {
  message?: string;
  statusMessage?: string;
  errors?: LoadingScreenError[];
  onRetry?: () => void;
  retryLabel?: string;
}

export function LoadingScreen(props: LoadingScreenProps) {
  const errors = props.errors ?? [];
  const hasErrors = errors.length > 0;
  const message =
    props.message ?? (hasErrors ? "Unable to load Mux data." : "Loading workspaces...");

  return (
    <div className="bg-bg-dark flex h-screen w-screen items-center justify-center">
      <div className="flex w-full max-w-lg flex-col items-center gap-4 px-6 text-center">
        {hasErrors ? (
          <AlertTriangle aria-hidden="true" className="text-danger h-12 w-12" />
        ) : (
          <div className="border-border-light h-12 w-12 animate-spin rounded-full border-4 border-t-transparent" />
        )}
        <div className="space-y-1">
          <p className="text-text-secondary text-sm">{message}</p>
          {props.statusMessage && (
            <p className="text-text-secondary text-xs">{props.statusMessage}</p>
          )}
        </div>
        {hasErrors && (
          <div className="flex w-full flex-col gap-2 text-left">
            {errors.map((error, index) => (
              <ErrorMessage
                key={`${error.title}-${index}`}
                title={error.title}
                message={error.message}
              />
            ))}
          </div>
        )}
        {hasErrors && props.onRetry && (
          <Button type="button" variant="secondary" size="sm" onClick={props.onRetry}>
            {props.retryLabel ?? "Retry"}
          </Button>
        )}
      </div>
    </div>
  );
}
