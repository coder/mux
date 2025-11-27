import { useState, useCallback } from "react";
import { Modal } from "./Modal";

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

  return (
    <Modal isOpen={props.isOpen} onClose={() => undefined} title="Authentication Required">
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <p style={{ margin: 0, color: "var(--color-text-secondary)" }}>
          This server requires an authentication token. Enter the token provided when the server was
          started.
        </p>

        {props.error && (
          <div
            style={{
              padding: "8px 12px",
              borderRadius: 4,
              backgroundColor: "var(--color-error-background, rgba(255, 0, 0, 0.1))",
              color: "var(--color-error, #ff6b6b)",
              fontSize: 13,
            }}
          >
            {props.error}
          </div>
        )}

        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Enter auth token"
          autoFocus
          style={{
            padding: "10px 12px",
            borderRadius: 4,
            border: "1px solid var(--color-border)",
            backgroundColor: "var(--color-input-background)",
            color: "var(--color-text)",
            fontSize: 14,
            outline: "none",
          }}
        />

        <button
          type="submit"
          disabled={!token.trim()}
          style={{
            padding: "10px 16px",
            borderRadius: 4,
            border: "none",
            backgroundColor: token.trim()
              ? "var(--color-primary)"
              : "var(--color-button-disabled-background)",
            color: token.trim() ? "white" : "var(--color-text-disabled)",
            fontSize: 14,
            fontWeight: 500,
            cursor: token.trim() ? "pointer" : "not-allowed",
          }}
        >
          Connect
        </button>
      </form>
    </Modal>
  );
}
