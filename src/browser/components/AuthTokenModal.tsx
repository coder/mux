import { useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/browser/components/ui/dialog";
import { Button } from "@/browser/components/ui/button";
import { getBrowserBackendBaseUrl } from "@/browser/utils/backendBaseUrl";
import { getErrorMessage } from "@/common/utils/errors";

interface AuthTokenModalProps {
  isOpen: boolean;
  onSubmit: (token: string) => void;
  onSessionAuthenticated?: () => void;
  error?: string | null;
}

interface ServerLoginOptionsResponse {
  githubDeviceFlowEnabled?: boolean;
}

interface GithubLoginStartResponse {
  flowId?: string;
  verificationUri?: string;
  userCode?: string;
  error?: string;
}

const AUTH_TOKEN_STORAGE_KEY = "mux:auth-token";

export function getStoredAuthToken(): string | null {
  try {
    return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredAuthToken(token: string): void {
  try {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
  } catch {
    // Ignore storage errors
  }
}

export function clearStoredAuthToken(): void {
  try {
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}

async function parseJsonResponse<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function AuthTokenModal(props: AuthTokenModalProps) {
  const [token, setToken] = useState("");
  const [githubDeviceFlowEnabled, setGithubDeviceFlowEnabled] = useState(false);
  const [githubOptionsLoading, setGithubOptionsLoading] = useState(true);

  const [githubLoginStatus, setGithubLoginStatus] = useState<
    "idle" | "starting" | "waiting" | "error"
  >("idle");
  const [githubLoginError, setGithubLoginError] = useState<string | null>(null);
  const [githubUserCode, setGithubUserCode] = useState<string | null>(null);
  const [githubVerificationUri, setGithubVerificationUri] = useState<string | null>(null);
  const [githubCodeCopied, setGithubCodeCopied] = useState(false);

  const waitAbortControllerRef = useRef<AbortController | null>(null);
  const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { onSubmit } = props;

  const clearGithubLoginUi = useCallback(() => {
    setGithubLoginStatus("idle");
    setGithubLoginError(null);
    setGithubUserCode(null);
    setGithubVerificationUri(null);
    setGithubCodeCopied(false);

    waitAbortControllerRef.current?.abort();
    waitAbortControllerRef.current = null;
  }, []);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (token.trim()) {
        setStoredAuthToken(token.trim());
        onSubmit(token.trim());
      }
    },
    [token, onSubmit]
  );

  useEffect(() => {
    if (!props.isOpen) {
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    setGithubOptionsLoading(true);

    void fetch(`${getBrowserBackendBaseUrl()}/auth/server-login/options`, {
      method: "GET",
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (cancelled) {
          return;
        }

        if (!response.ok) {
          setGithubDeviceFlowEnabled(false);
          setGithubOptionsLoading(false);
          return;
        }

        const payload = await parseJsonResponse<ServerLoginOptionsResponse>(response);
        setGithubDeviceFlowEnabled(payload?.githubDeviceFlowEnabled === true);
        setGithubOptionsLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        const isAbortError = error instanceof DOMException && error.name === "AbortError";
        if (!isAbortError) {
          setGithubDeviceFlowEnabled(false);
          setGithubOptionsLoading(false);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [props.isOpen]);

  useEffect(() => {
    return () => {
      waitAbortControllerRef.current?.abort();
      if (copiedTimeoutRef.current !== null) {
        clearTimeout(copiedTimeoutRef.current);
      }
    };
  }, []);

  const startGithubLogin = useCallback(async () => {
    clearGithubLoginUi();
    setGithubLoginStatus("starting");

    try {
      const startResponse = await fetch(
        `${getBrowserBackendBaseUrl()}/auth/server-login/github/start`,
        {
          method: "POST",
          credentials: "include",
        }
      );

      const startPayload = await parseJsonResponse<GithubLoginStartResponse>(startResponse);

      if (!startResponse.ok) {
        setGithubLoginStatus("error");
        setGithubLoginError(startPayload?.error ?? "Failed to start GitHub login");
        return;
      }

      const flowId = startPayload?.flowId?.trim();
      const verificationUri = startPayload?.verificationUri?.trim();
      const userCode = startPayload?.userCode?.trim();

      if (!flowId || !verificationUri || !userCode) {
        setGithubLoginStatus("error");
        setGithubLoginError("Server returned an invalid GitHub login response");
        return;
      }

      setGithubLoginStatus("waiting");
      setGithubVerificationUri(verificationUri);
      setGithubUserCode(userCode);

      window.open(verificationUri, "_blank", "noopener");

      const waitController = new AbortController();
      waitAbortControllerRef.current = waitController;

      try {
        const waitResponse = await fetch(
          `${getBrowserBackendBaseUrl()}/auth/server-login/github/wait`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            credentials: "include",
            body: JSON.stringify({ flowId }),
            signal: waitController.signal,
          }
        );

        const waitPayload = await parseJsonResponse<{ ok?: boolean; error?: string }>(waitResponse);

        if (!waitResponse.ok || waitPayload?.ok !== true) {
          setGithubLoginStatus("error");
          setGithubLoginError(waitPayload?.error ?? "GitHub login failed");
          return;
        }

        clearStoredAuthToken();
        props.onSessionAuthenticated?.();
      } catch (error) {
        const isAbortError = error instanceof DOMException && error.name === "AbortError";
        if (isAbortError) {
          return;
        }

        const message = getErrorMessage(error);
        setGithubLoginStatus("error");
        setGithubLoginError(message);
      } finally {
        if (waitAbortControllerRef.current === waitController) {
          waitAbortControllerRef.current = null;
        }
      }
    } catch (error) {
      const message = getErrorMessage(error);
      setGithubLoginStatus("error");
      setGithubLoginError(message);
    }
  }, [clearGithubLoginUi, props]);

  const copyGithubUserCode = useCallback(() => {
    if (!githubUserCode) {
      return;
    }

    void navigator.clipboard.writeText(githubUserCode);
    setGithubCodeCopied(true);

    if (copiedTimeoutRef.current !== null) {
      clearTimeout(copiedTimeoutRef.current);
    }

    copiedTimeoutRef.current = setTimeout(() => {
      setGithubCodeCopied(false);
    }, 2_000);
  }, [githubUserCode]);

  // This modal cannot be dismissed without providing a token/session.
  const handleOpenChange = useCallback(() => {
    // Do nothing - modal cannot be closed without submitting
  }, []);

  return (
    <Dialog open={props.isOpen} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Authentication Required</DialogTitle>
          <DialogDescription>
            This server requires authentication. Enter the token provided at startup, or sign in
            with GitHub when enabled.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {props.error && (
            <div className="bg-error-bg text-error rounded p-2 px-3 text-[13px]">{props.error}</div>
          )}

          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Enter auth token"
            autoFocus
            className="bg-modal-bg border-border-medium focus:border-accent placeholder:text-muted text-foreground rounded border px-3 py-2.5 text-sm focus:outline-none"
          />

          <DialogFooter className="pt-0">
            <Button type="submit" disabled={!token.trim()} className="w-full">
              Connect with token
            </Button>
          </DialogFooter>
        </form>

        {githubOptionsLoading ? null : githubDeviceFlowEnabled ? (
          <div className="border-border-medium space-y-3 border-t pt-3">
            <div className="text-foreground text-sm font-medium">Or login with GitHub</div>

            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  void startGithubLogin();
                }}
                disabled={githubLoginStatus === "starting" || githubLoginStatus === "waiting"}
                className="w-full"
              >
                {githubLoginStatus === "waiting"
                  ? "Waiting for GitHub authorization..."
                  : githubLoginStatus === "starting"
                    ? "Starting GitHub login..."
                    : githubLoginStatus === "error"
                      ? "Retry GitHub login"
                      : "Login with GitHub"}
              </Button>
            </div>

            {githubLoginStatus === "waiting" && githubUserCode ? (
              <div className="bg-background-tertiary space-y-2 rounded-md p-3">
                <p className="text-muted text-xs">Enter this code on GitHub:</p>
                <div className="flex items-center gap-2">
                  <code className="text-accent text-lg font-bold tracking-widest">
                    {githubUserCode}
                  </code>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Copy GitHub verification code"
                    onClick={copyGithubUserCode}
                    className="text-muted hover:text-foreground h-auto px-1 py-0 text-xs"
                  >
                    {githubCodeCopied ? "Copied!" : "Copy"}
                  </Button>
                </div>
                {githubVerificationUri ? (
                  <p className="text-muted text-xs">
                    If the browser didn&apos;t open,{" "}
                    <a
                      href={githubVerificationUri}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent hover:text-accent-light underline"
                    >
                      open the verification page
                    </a>
                    .
                  </p>
                ) : null}
              </div>
            ) : null}

            {githubLoginError ? (
              <p className="text-destructive text-xs">GitHub login failed: {githubLoginError}</p>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
