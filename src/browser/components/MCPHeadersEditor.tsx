import React from "react";
import { ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/browser/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/browser/components/ui/toggle-group";
import {
  createMCPHeaderRow,
  mcpHeaderRowsToRecord,
  type MCPHeaderRow,
} from "@/browser/utils/mcpHeaders";

export const MCPHeadersEditor: React.FC<{
  rows: MCPHeaderRow[];
  onChange: (rows: MCPHeaderRow[]) => void;
  secretKeys: string[];
  disabled?: boolean;
}> = (props) => {
  const [openSecretPickerRowId, setOpenSecretPickerRowId] = React.useState<string | null>(null);
  const sortedSecretKeys = props.secretKeys
    .slice()
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const { validation } = mcpHeaderRowsToRecord(props.rows, {
    knownSecretKeys: new Set(props.secretKeys),
  });

  const addRow = () => {
    props.onChange([...props.rows, createMCPHeaderRow()]);
  };

  const removeRow = (id: string) => {
    props.onChange(props.rows.filter((row) => row.id !== id));
    if (openSecretPickerRowId === id) {
      setOpenSecretPickerRowId(null);
    }
  };

  const updateRow = (id: string, patch: Partial<Omit<MCPHeaderRow, "id">>) => {
    props.onChange(
      props.rows.map((row) => {
        if (row.id !== id) {
          return row;
        }
        const next: MCPHeaderRow = {
          ...row,
          ...patch,
        };

        // If they flip kind, keep value but allow the placeholder/suggestions to change.
        return next;
      })
    );
  };

  return (
    <div className="space-y-2">
      {props.rows.length === 0 ? (
        <div className="text-muted border-border-medium rounded-md border border-dashed px-3 py-3 text-center text-xs">
          No headers configured
        </div>
      ) : (
        <div className="[&>label]:text-muted grid grid-cols-[1fr_auto_1fr_auto] items-end gap-1 [&>label]:mb-0.5 [&>label]:text-[11px]">
          <label>Header</label>
          <label>Type</label>
          <label>Value</label>
          <div />

          {props.rows.map((row) => (
            <React.Fragment key={row.id}>
              <input
                type="text"
                value={row.name}
                onChange={(e) => updateRow(row.id, { name: e.target.value })}
                placeholder="Authorization"
                disabled={props.disabled}
                spellCheck={false}
                className="bg-modal-bg border-border-medium focus:border-accent placeholder:text-dim text-foreground w-full rounded border px-2.5 py-1.5 font-mono text-[13px] focus:outline-none disabled:opacity-50"
              />

              <ToggleGroup
                type="single"
                value={row.kind}
                onValueChange={(value) => {
                  if (value !== "text" && value !== "secret") {
                    return;
                  }

                  updateRow(row.id, { kind: value });

                  if (value !== "secret" && openSecretPickerRowId === row.id) {
                    setOpenSecretPickerRowId(null);
                  }
                }}
                size="sm"
                disabled={props.disabled}
                className="h-[34px]"
              >
                <ToggleGroupItem value="text" size="sm" className="h-[26px] px-3 text-[13px]">
                  Text
                </ToggleGroupItem>
                <ToggleGroupItem value="secret" size="sm" className="h-[26px] px-3 text-[13px]">
                  Secret
                </ToggleGroupItem>
              </ToggleGroup>

              {row.kind === "secret" ? (
                <div className="flex items-stretch gap-1">
                  <input
                    type="text"
                    value={row.value}
                    onChange={(e) => updateRow(row.id, { value: e.target.value })}
                    placeholder="MCP_TOKEN"
                    disabled={props.disabled}
                    spellCheck={false}
                    className="bg-modal-bg border-border-medium focus:border-accent placeholder:text-dim text-foreground w-full flex-1 rounded border px-2.5 py-1.5 font-mono text-[13px] focus:outline-none disabled:opacity-50"
                  />

                  {sortedSecretKeys.length > 0 && (
                    <Popover
                      open={openSecretPickerRowId === row.id}
                      onOpenChange={(open) => setOpenSecretPickerRowId(open ? row.id : null)}
                    >
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          aria-label="Choose secret"
                          title="Choose secret"
                          disabled={props.disabled}
                          className="bg-modal-bg border-border-medium focus:border-accent hover:bg-hover text-muted hover:text-foreground flex cursor-pointer items-center justify-center rounded border px-2.5 py-1.5 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <ChevronDown className="h-4 w-4" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent align="end" sideOffset={4} className="p-1">
                        <div className="max-h-48 overflow-auto">
                          {(row.value.trim() === ""
                            ? sortedSecretKeys
                            : sortedSecretKeys.filter((key) =>
                                key.toLowerCase().includes(row.value.trim().toLowerCase())
                              )
                          ).map((key) => (
                            <button
                              key={key}
                              type="button"
                              onClick={() => {
                                updateRow(row.id, { value: key });
                                setOpenSecretPickerRowId(null);
                              }}
                              className="hover:bg-hover text-foreground w-full cursor-pointer rounded px-2 py-1 text-left font-mono text-xs"
                            >
                              {key}
                            </button>
                          ))}
                        </div>
                      </PopoverContent>
                    </Popover>
                  )}
                </div>
              ) : (
                <input
                  type="text"
                  value={row.value}
                  onChange={(e) => updateRow(row.id, { value: e.target.value })}
                  placeholder="value"
                  disabled={props.disabled}
                  spellCheck={false}
                  className="bg-modal-bg border-border-medium focus:border-accent placeholder:text-dim text-foreground w-full rounded border px-2.5 py-1.5 font-mono text-[13px] focus:outline-none disabled:opacity-50"
                />
              )}

              <button
                type="button"
                onClick={() => removeRow(row.id)}
                disabled={props.disabled}
                className="text-danger-light border-danger-light hover:bg-danger-light/10 cursor-pointer rounded border bg-transparent px-2.5 py-1.5 text-[13px] transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50"
                title="Remove header"
              >
                ×
              </button>
            </React.Fragment>
          ))}
        </div>
      )}

      {validation.errors.length > 0 && (
        <div className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-xs">
          {validation.errors.map((msg, i) => (
            <div key={i}>{msg}</div>
          ))}
        </div>
      )}

      {validation.errors.length === 0 && validation.warnings.length > 0 && (
        <div className="text-muted rounded-md px-1 text-xs">
          {validation.warnings.map((msg, i) => (
            <div key={i}>{msg}</div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={addRow}
        disabled={props.disabled}
        className="text-muted border-border-medium hover:bg-hover hover:border-border-darker hover:text-foreground w-full cursor-pointer rounded border border-dashed bg-transparent px-3 py-2 text-[13px] transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50"
      >
        + Add header
      </button>
    </div>
  );
};
