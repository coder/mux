import React, { useState, useEffect, useCallback } from "react";
import { Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogInfo,
} from "@/browser/components/ui/dialog";
import { Button } from "@/browser/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/browser/components/ui/toggle-group";
import { useAPI } from "@/browser/contexts/API";
import type { Secret } from "@/common/types/secrets";

// Visibility toggle icon component
const ToggleVisibilityIcon: React.FC<{ visible: boolean }> = ({ visible }) => {
  if (visible) {
    // Eye-off icon (with slash) - password is visible
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
        <line x1="1" y1="1" x2="23" y2="23" />
      </svg>
    );
  }

  // Eye icon - password is hidden
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
};

function isSecretReferenceValue(value: Secret["value"]): value is { secret: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "secret" in value &&
    typeof (value as { secret?: unknown }).secret === "string"
  );
}

function secretValueIsNonEmpty(value: Secret["value"]): boolean {
  if (typeof value === "string") {
    return value.trim() !== "";
  }

  if (isSecretReferenceValue(value)) {
    return value.secret.trim() !== "";
  }

  return false;
}

interface SecretsModalProps {
  isOpen: boolean;
  projectPath: string;
  projectName: string;
  initialSecrets: Secret[];
  onClose: () => void;
  onSave: (secrets: Secret[]) => Promise<void>;
}

const SecretsModal: React.FC<SecretsModalProps> = ({
  isOpen,
  projectPath: _projectPath,
  projectName,
  initialSecrets,
  onClose,
  onSave,
}) => {
  const { api } = useAPI();

  const [globalSecretKeys, setGlobalSecretKeys] = useState<string[]>([]);
  const sortedGlobalSecretKeys = globalSecretKeys
    .slice()
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  const [secrets, setSecrets] = useState<Secret[]>(initialSecrets);
  const [visibleSecrets, setVisibleSecrets] = useState<Set<number>>(new Set());
  const [isLoading, setIsLoading] = useState(false);

  // Reset state when modal opens with new secrets
  useEffect(() => {
    if (isOpen) {
      setSecrets(initialSecrets);
      setVisibleSecrets(new Set());
    }
  }, [isOpen, initialSecrets]);

  // Load global secret keys (used for {secret:"KEY"} project secret values).
  useEffect(() => {
    if (!api || !isOpen) {
      setGlobalSecretKeys([]);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const secrets = await api.secrets.get({});
        if (cancelled) return;
        setGlobalSecretKeys(secrets.map((s) => s.key));
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to load global secrets:", err);
        setGlobalSecretKeys([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api, isOpen]);

  const handleCancel = useCallback(() => {
    setSecrets(initialSecrets);
    setVisibleSecrets(new Set());
    onClose();
  }, [initialSecrets, onClose]);

  const handleSave = async () => {
    setIsLoading(true);
    try {
      // Filter out empty secrets
      const validSecrets = secrets.filter(
        (s) => s.key.trim() !== "" && secretValueIsNonEmpty(s.value)
      );
      await onSave(validSecrets);
      onClose();
    } catch (err) {
      console.error("Failed to save secrets:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const addSecret = () => {
    setSecrets((prev) => [...prev, { key: "", value: "" }]);
  };

  const removeSecret = (index: number) => {
    setSecrets((prev) => prev.filter((_, i) => i !== index));

    // Keep visibility state aligned with the remaining rows.
    //
    // Visibility is tracked by array index; deleting a row shifts later indices.
    // If we don't shift the visibility set too, we can end up revealing a different secret.
    setVisibleSecrets((prev) => {
      const next = new Set<number>();
      for (const visibleIndex of prev) {
        if (visibleIndex === index) {
          continue;
        }
        next.add(visibleIndex > index ? visibleIndex - 1 : visibleIndex);
      }
      return next;
    });
  };

  const updateSecretKey = (index: number, value: string) => {
    setSecrets((prev) => {
      const next = [...prev];
      const existing = next[index] ?? { key: "", value: "" };

      // Auto-capitalize key field for env variable convention.
      next[index] = { ...existing, key: value.toUpperCase() };
      return next;
    });
  };

  const updateSecretValue = (index: number, value: Secret["value"]) => {
    setSecrets((prev) => {
      const next = [...prev];
      const existing = next[index] ?? { key: "", value: "" };
      next[index] = { ...existing, value };
      return next;
    });
  };

  const updateSecretValueKind = (index: number, kind: "literal" | "global") => {
    setSecrets((prev) => {
      const next = [...prev];
      const existing = next[index] ?? { key: "", value: "" };

      if (kind === "literal") {
        next[index] = {
          ...existing,
          value: typeof existing.value === "string" ? existing.value : "",
        };
        return next;
      }

      if (isSecretReferenceValue(existing.value)) {
        return next;
      }

      const defaultKey = sortedGlobalSecretKeys[0] ?? "";
      next[index] = {
        ...existing,
        value: { secret: defaultKey },
      };
      return next;
    });
  };

  const toggleVisibility = (index: number) => {
    setVisibleSecrets((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !isLoading) {
        handleCancel();
      }
    },
    [isLoading, handleCancel]
  );

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent maxWidth="600px" maxHeight="80vh" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Manage Secrets</DialogTitle>
          <DialogDescription>Project: {projectName}</DialogDescription>
        </DialogHeader>
        <DialogInfo>
          <p>
            Secrets are stored in <code>~/.mux/secrets.json</code> (kept away from source code) but
            namespaced per project.
          </p>
          <p>Secrets are injected as environment variables to compute commands (e.g. Bash)</p>
        </DialogInfo>

        <div className="mb-4 min-h-[200px] flex-1 overflow-y-auto">
          {secrets.length === 0 ? (
            <div className="text-muted px-4 py-8 text-center text-[13px]">
              No secrets configured
            </div>
          ) : (
            <div className="[&>label]:text-muted grid grid-cols-[1fr_auto_1fr_auto_auto] items-end gap-1 [&>label]:mb-0.5 [&>label]:text-[11px]">
              <label>Key</label>
              <label>Type</label>
              <label>Value</label>
              <div />
              <div />

              {secrets.map((secret, index) => {
                const isReference = isSecretReferenceValue(secret.value);
                const kind = isReference ? "global" : "literal";
                const referencedKey = isSecretReferenceValue(secret.value)
                  ? secret.value.secret
                  : "";
                const availableKeys =
                  referencedKey && !sortedGlobalSecretKeys.includes(referencedKey)
                    ? [referencedKey, ...sortedGlobalSecretKeys]
                    : sortedGlobalSecretKeys;

                return (
                  <React.Fragment key={index}>
                    <input
                      type="text"
                      value={secret.key}
                      onChange={(e) => updateSecretKey(index, e.target.value)}
                      placeholder="SECRET_NAME"
                      aria-label="Secret key"
                      disabled={isLoading}
                      spellCheck={false}
                      className="bg-modal-bg border-border-medium focus:border-accent placeholder:text-dim text-foreground w-full rounded border px-2.5 py-1.5 font-mono text-[13px] focus:outline-none disabled:opacity-50"
                    />

                    <ToggleGroup
                      type="single"
                      value={kind}
                      onValueChange={(value) => {
                        if (value !== "literal" && value !== "global") {
                          return;
                        }
                        updateSecretValueKind(index, value);
                      }}
                      size="sm"
                      className="h-[34px]"
                      disabled={isLoading}
                    >
                      <ToggleGroupItem
                        value="literal"
                        size="sm"
                        className="h-[26px] px-3 text-[13px]"
                      >
                        Value
                      </ToggleGroupItem>
                      <ToggleGroupItem
                        value="global"
                        size="sm"
                        className="h-[26px] px-3 text-[13px]"
                        disabled={availableKeys.length === 0}
                      >
                        Global
                      </ToggleGroupItem>
                    </ToggleGroup>

                    {isReference ? (
                      <Select
                        value={referencedKey || undefined}
                        onValueChange={(value) => updateSecretValue(index, { secret: value })}
                        disabled={isLoading}
                      >
                        <SelectTrigger
                          className="border-border-medium bg-modal-bg hover:bg-hover h-[34px] w-full px-2.5 font-mono text-[13px]"
                          aria-label="Global secret key"
                        >
                          <SelectValue placeholder="Select global secret" />
                        </SelectTrigger>
                        <SelectContent>
                          {availableKeys.map((key) => (
                            <SelectItem key={key} value={key}>
                              {key}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <input
                        type={visibleSecrets.has(index) ? "text" : "password"}
                        value={
                          typeof secret.value === "string"
                            ? secret.value
                            : isSecretReferenceValue(secret.value)
                              ? secret.value.secret
                              : ""
                        }
                        onChange={(e) => updateSecretValue(index, e.target.value)}
                        placeholder="secret value"
                        aria-label="Secret value"
                        disabled={isLoading}
                        spellCheck={false}
                        className="bg-modal-bg border-border-medium focus:border-accent placeholder:text-dim text-foreground w-full rounded border px-2.5 py-1.5 font-mono text-[13px] focus:outline-none disabled:opacity-50"
                      />
                    )}

                    {isReference ? (
                      <div />
                    ) : (
                      <button
                        type="button"
                        onClick={() => toggleVisibility(index)}
                        disabled={isLoading}
                        className="text-muted hover:text-foreground flex cursor-pointer items-center justify-center self-center rounded-sm border-none bg-transparent px-1 py-0.5 text-base transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label={visibleSecrets.has(index) ? "Hide secret" : "Show secret"}
                      >
                        <ToggleVisibilityIcon visible={visibleSecrets.has(index)} />
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => removeSecret(index)}
                      disabled={isLoading}
                      className="text-danger-light border-danger-light hover:bg-danger-light/10 cursor-pointer rounded border bg-transparent px-2.5 py-1.5 text-[13px] transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label="Remove secret"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </React.Fragment>
                );
              })}
            </div>
          )}
        </div>

        <button
          onClick={addSecret}
          disabled={isLoading}
          className="text-muted border-border-medium hover:bg-hover hover:border-border-darker hover:text-foreground mb-4 w-full cursor-pointer rounded border border-dashed bg-transparent px-3 py-2 text-[13px] transition-all duration-200"
        >
          + Add Secret
        </button>

        <DialogFooter>
          <Button variant="secondary" type="button" onClick={handleCancel} disabled={isLoading}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSave()} disabled={isLoading}>
            {isLoading ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default SecretsModal;
