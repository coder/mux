import React, { useState, useEffect } from "react";
import { Modal, ModalInfo, ModalActions, CancelButton, PrimaryButton } from "./Modal";
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

  const handleCancel = () => {
    setSecrets(initialSecrets);
    setVisibleSecrets(new Set());
    onClose();
  };

  const handleSave = async () => {
    setIsLoading(true);
    try {
      // Filter out empty secrets
      const validSecrets = secrets.filter((s) => s.key.trim() !== "" && s.value.trim() !== "");
      await onSave(validSecrets);
      onClose();
    } catch (err) {
      console.error("Failed to save secrets:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const addSecret = () => {
    setSecrets([...secrets, { key: "", value: "" }]);
  };

  const removeSecret = (index: number) => {
    setSecrets(secrets.filter((_, i) => i !== index));
    // Clean up visibility state
    const newVisible = new Set(visibleSecrets);
    newVisible.delete(index);
    setVisibleSecrets(newVisible);
  };

  const updateSecret = (index: number, field: "key" | "value", value: string) => {
    const newSecrets = [...secrets];
    // Auto-capitalize key field for env variable convention
    const processedValue = field === "key" ? value.toUpperCase() : value;
    newSecrets[index] = { ...newSecrets[index], [field]: processedValue };
    setSecrets(newSecrets);
  };

  const toggleVisibility = (index: number) => {
    const newVisible = new Set(visibleSecrets);
    if (newVisible.has(index)) {
      newVisible.delete(index);
    } else {
      newVisible.add(index);
    }
    setVisibleSecrets(newVisible);
  };

  return (
    <Modal
      isOpen={isOpen}
      title="Manage Secrets"
      subtitle={`Project: ${projectName}`}
      onClose={handleCancel}
      maxWidth="600px"
      maxHeight="80vh"
      isLoading={isLoading}
    >
      <ModalInfo>
        <p>
          Secrets are stored in <code>~/.mux/secrets.json</code> (kept away from source code) but
          namespaced per project.
        </p>
        <p>Secrets are injected as environment variables to compute commands (e.g. Bash)</p>
      </ModalInfo>

      <div className="mb-4 min-h-[200px] flex-1 overflow-y-auto">
        {secrets.length === 0 ? (
          <div className="text-muted px-4 py-8 text-center text-[13px]">No secrets configured</div>
        ) : (
          <div className="[&>label]:text-muted grid grid-cols-[1fr_1fr_auto_auto] items-end gap-1 [&>label]:mb-0.5 [&>label]:text-[11px]">
            <label>Key</label>
            <label>Value</label>
            <div /> {/* Empty cell for eye icon column */}
            <div /> {/* Empty cell for delete button column */}
            {secrets.map((secret, index) => (
              <React.Fragment key={index}>
                <input
                  type="text"
                  value={secret.key}
                  onChange={(e) => updateSecret(index, "key", e.target.value)}
                  placeholder="SECRET_NAME"
                  disabled={isLoading}
                  className="bg-modal-bg border-border-medium focus:border-accent placeholder:text-dim w-full rounded border px-2.5 py-1.5 font-mono text-[13px] text-white focus:outline-none"
                />
                <input
                  type={visibleSecrets.has(index) ? "text" : "password"}
                  value={secret.value}
                  onChange={(e) => updateSecret(index, "value", e.target.value)}
                  placeholder="secret value"
                  disabled={isLoading}
                  className="bg-modal-bg border-border-medium focus:border-accent placeholder:text-dim w-full rounded border px-2.5 py-1.5 font-mono text-[13px] text-white focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => toggleVisibility(index)}
                  disabled={isLoading}
                  className="text-muted hover:text-foreground flex cursor-pointer items-center justify-center self-center rounded-sm border-none bg-transparent px-1 py-0.5 text-base transition-all duration-200"
                >
                  <ToggleVisibilityIcon visible={visibleSecrets.has(index)} />
                </button>
                <button
                  type="button"
                  onClick={() => removeSecret(index)}
                  disabled={isLoading}
                  className="text-danger-light border-danger-light hover:bg-danger-light/10 cursor-pointer rounded border bg-transparent px-2.5 py-1.5 text-[13px] transition-all duration-200"
                >
                  ×
                </button>
              </React.Fragment>
            ))}
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

      <ModalActions>
        <CancelButton type="button" onClick={handleCancel} disabled={isLoading}>
          Cancel
        </CancelButton>
        <PrimaryButton type="button" onClick={() => void handleSave()} disabled={isLoading}>
          {isLoading ? "Saving..." : "Save"}
        </PrimaryButton>
      </ModalActions>
    </Modal>
  );
};

export default SecretsModal;
