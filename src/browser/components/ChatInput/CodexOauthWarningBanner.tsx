import { AlertTriangle } from "lucide-react";
import { Button } from "@/browser/components/ui/button";
import { KNOWN_MODELS } from "@/common/constants/knownModels";

interface Props {
  activeModel: string;
  codexOauthSet: boolean | null;
  onOpenProviders: () => void;
}

// GPT-5.3 Codex is the only model that currently requires ChatGPT OAuth.
// Show this early warning before send so users don't hit confusing access errors.
const CODEX_OAUTH_WARNING_MODEL = KNOWN_MODELS.GPT_53_CODEX.id;

export function CodexOauthWarningBanner(props: Props) {
  const shouldShowWarning =
    props.activeModel === CODEX_OAUTH_WARNING_MODEL && props.codexOauthSet === false;

  if (!shouldShowWarning) {
    return null;
  }

  return (
    <div
      data-testid="codex-oauth-warning-banner"
      className="bg-warning/10 border-warning/30 text-warning mt-1 mb-2 flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-xs"
    >
      <div className="flex min-w-0 items-start gap-2">
        <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p className="leading-relaxed">
          <span className="font-medium">GPT-5.3 Codex OAuth is not connected.</span> Open Settings →
          Providers to connect OpenAI before sending.
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={props.onOpenProviders}
        className="border-warning/40 text-warning hover:bg-warning/15 hover:text-warning shrink-0"
      >
        Providers
      </Button>
    </div>
  );
}
