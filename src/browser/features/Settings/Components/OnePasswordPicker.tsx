import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, KeyRound, Loader2 } from "lucide-react";

import { Button } from "@/browser/components/Button/Button";
import { useAPI } from "@/browser/contexts/API";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";

interface OnePasswordVault {
  id: string;
  title: string;
}

interface OnePasswordItem {
  id: string;
  title: string;
  category: string;
}

interface OnePasswordField {
  id: string;
  title: string;
  sectionTitle?: string | null;
  sectionId?: string | null;
}

type PickerStep =
  | { kind: "vault" }
  | { kind: "item"; vault: OnePasswordVault }
  | { kind: "field"; vault: OnePasswordVault; item: OnePasswordItem };

interface OnePasswordPickerProps {
  onSelect: (opRef: string, opLabel: string) => void;
  onCancel: () => void;
}

export function OnePasswordPicker(props: OnePasswordPickerProps) {
  const { api } = useAPI();

  const [step, setStep] = useState<PickerStep>({ kind: "vault" });
  const [vaults, setVaults] = useState<OnePasswordVault[]>([]);
  const [items, setItems] = useState<OnePasswordItem[]>([]);
  const [fields, setFields] = useState<OnePasswordField[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guard against out-of-order async responses if the user navigates quickly.
  const requestVersionRef = useRef(0);

  useEffect(() => {
    if (!api) {
      setVaults([]);
      setError("Mux API not connected.");
      setLoading(false);
      return;
    }

    let cancelled = false;
    const requestVersion = ++requestVersionRef.current;

    setLoading(true);
    setError(null);

    void api.onePassword
      .listVaults()
      .then((nextVaults) => {
        if (cancelled || requestVersion !== requestVersionRef.current) {
          return;
        }

        setVaults(nextVaults);
      })
      .catch((err) => {
        if (cancelled || requestVersion !== requestVersionRef.current) {
          return;
        }

        setError(getErrorMessage(err));
      })
      .finally(() => {
        if (cancelled || requestVersion !== requestVersionRef.current) {
          return;
        }

        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [api]);

  const handleBack = () => {
    requestVersionRef.current++;
    setLoading(false);
    setError(null);

    if (step.kind === "field") {
      setStep({ kind: "item", vault: step.vault });
      setFields([]);
      return;
    }

    if (step.kind === "item") {
      setStep({ kind: "vault" });
      setItems([]);
    }
  };

  const handleVaultSelect = async (vault: OnePasswordVault) => {
    assert(vault.id.length > 0, "OnePasswordPicker: vault.id must be non-empty");
    assert(vault.title.length > 0, "OnePasswordPicker: vault.title must be non-empty");

    if (!api) {
      setError("Mux API not connected.");
      return;
    }

    const requestVersion = ++requestVersionRef.current;
    setStep({ kind: "item", vault });
    setItems([]);
    setFields([]);
    setLoading(true);
    setError(null);

    try {
      const nextItems = await api.onePassword.listItems({ vaultId: vault.id });
      if (requestVersion !== requestVersionRef.current) {
        return;
      }

      setItems(nextItems);
    } catch (err) {
      if (requestVersion !== requestVersionRef.current) {
        return;
      }

      setError(getErrorMessage(err));
    } finally {
      if (requestVersion === requestVersionRef.current) {
        setLoading(false);
      }
    }
  };

  const handleItemSelect = async (item: OnePasswordItem) => {
    assert(item.id.length > 0, "OnePasswordPicker: item.id must be non-empty");
    assert(item.title.length > 0, "OnePasswordPicker: item.title must be non-empty");

    if (!api) {
      setError("Mux API not connected.");
      return;
    }

    if (step.kind !== "item") {
      setError("Invalid picker state while selecting a 1Password item.");
      return;
    }

    const requestVersion = ++requestVersionRef.current;
    setStep({ kind: "field", vault: step.vault, item });
    setFields([]);
    setLoading(true);
    setError(null);

    try {
      const nextFields = await api.onePassword.getItemFields({
        vaultId: step.vault.id,
        itemId: item.id,
      });
      if (requestVersion !== requestVersionRef.current) {
        return;
      }

      setFields(nextFields);
    } catch (err) {
      if (requestVersion !== requestVersionRef.current) {
        return;
      }

      setError(getErrorMessage(err));
    } finally {
      if (requestVersion === requestVersionRef.current) {
        setLoading(false);
      }
    }
  };

  const handleFieldSelect = async (field: OnePasswordField) => {
    assert(field.id.length > 0, "OnePasswordPicker: field.id must be non-empty");
    assert(field.title.length > 0, "OnePasswordPicker: field.title must be non-empty");

    if (!api) {
      setError("Mux API not connected.");
      return;
    }

    if (step.kind !== "field") {
      setError("Invalid picker state while selecting a 1Password field.");
      return;
    }

    const requestVersion = ++requestVersionRef.current;
    setLoading(true);
    setError(null);

    try {
      const result = await api.onePassword.buildReference({
        vaultId: step.vault.id,
        itemId: step.item.id,
        fieldId: field.id,
        sectionId: field.sectionId,
        vaultTitle: step.vault.title,
        itemTitle: step.item.title,
        fieldTitle: field.title,
        sectionTitle: field.sectionTitle,
      });

      if (requestVersion !== requestVersionRef.current) {
        return;
      }

      props.onSelect(result.reference, result.label);
    } catch (err) {
      if (requestVersion !== requestVersionRef.current) {
        return;
      }

      setError(getErrorMessage(err));
      setLoading(false);
    }
  };

  const headerLabel =
    step.kind === "vault"
      ? "Select a Vault"
      : step.kind === "item"
        ? `Vault: ${step.vault.title}`
        : `Item: ${step.item.title}`;

  const emptyLabel =
    step.kind === "vault"
      ? "No vaults found."
      : step.kind === "item"
        ? "No items found in this vault."
        : "No fields found for this item.";

  const showBackButton = step.kind !== "vault";

  return (
    <div className="bg-modal-bg border-border-medium mt-2 rounded border p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {showBackButton && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleBack}
              className="text-muted hover:text-foreground h-auto px-1 py-0 text-xs"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Back
            </Button>
          )}
          <span className="text-muted text-xs font-medium">{headerLabel}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={props.onCancel}
          className="text-muted hover:text-foreground h-auto px-1 py-0 text-xs"
        >
          Cancel
        </Button>
      </div>

      <div className="space-y-1">
        {loading ? (
          <div className="text-muted flex items-center gap-2 px-2 py-1.5 text-xs">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading 1Password data...
          </div>
        ) : error ? (
          <div className="text-error px-2 py-1.5 text-xs">{error}</div>
        ) : step.kind === "vault" ? (
          vaults.length === 0 ? (
            <div className="text-muted px-2 py-1.5 text-xs">{emptyLabel}</div>
          ) : (
            vaults.map((vault) => (
              <button
                key={vault.id}
                type="button"
                onClick={() => void handleVaultSelect(vault)}
                className="hover:bg-hover text-foreground flex w-full cursor-pointer items-center justify-between rounded px-2 py-1.5 text-xs"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <KeyRound className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate text-left">{vault.title}</span>
                </span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0" />
              </button>
            ))
          )
        ) : step.kind === "item" ? (
          items.length === 0 ? (
            <div className="text-muted px-2 py-1.5 text-xs">{emptyLabel}</div>
          ) : (
            items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => void handleItemSelect(item)}
                className="hover:bg-hover text-foreground flex w-full cursor-pointer items-center justify-between rounded px-2 py-1.5 text-xs"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <KeyRound className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate text-left">{item.title}</span>
                </span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0" />
              </button>
            ))
          )
        ) : fields.length === 0 ? (
          <div className="text-muted px-2 py-1.5 text-xs">{emptyLabel}</div>
        ) : (
          fields.map((field) => {
            const sectionPrefix = field.sectionTitle ? `${field.sectionTitle} / ` : "";

            return (
              <button
                key={field.id}
                type="button"
                onClick={() => void handleFieldSelect(field)}
                className="hover:bg-hover text-foreground flex w-full cursor-pointer items-center justify-between rounded px-2 py-1.5 text-xs"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <KeyRound className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate text-left">
                    {sectionPrefix}
                    {field.title}
                  </span>
                </span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0" />
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
