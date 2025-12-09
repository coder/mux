import { useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/browser/components/ui/dialog";
import { Button } from "@/browser/components/ui/button";

interface AuthTokenModalProps {
  isOpen: boolean;
  onSubmit: (token: string) => void;
  error?: string | null;
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

export function AuthTokenModal(props: AuthTokenModalProps) {
  const [token, setToken] = useState("");

  const { onSubmit } = props;
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

  // This modal cannot be dismissed without providing a token
  const handleOpenChange = useCallback(() => {
    // Do nothing - modal cannot be closed without submitting
  }, []);

  return (
    <Dialog open={props.isOpen} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Authentication Required</DialogTitle>
          <DialogDescription>
            This server requires an authentication token. Enter the token provided when the server
            was started.
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
              Connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
