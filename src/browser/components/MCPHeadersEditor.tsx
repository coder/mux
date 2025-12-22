import React, { useId } from "react";
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
  const datalistId = useId();
  const { validation } = mcpHeaderRowsToRecord(props.rows, {
    knownSecretKeys: new Set(props.secretKeys),
  });

  const addRow = () => {
    props.onChange([...props.rows, createMCPHeaderRow()]);
  };

  const removeRow = (id: string) => {
    props.onChange(props.rows.filter((row) => row.id !== id));
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
                className="bg-modal-bg border-border-medium focus:border-accent placeholder:text-dim w-full rounded border px-2.5 py-1.5 font-mono text-[13px] text-white focus:outline-none disabled:opacity-50"
              />

              <ToggleGroup
                type="single"
                value={row.kind}
                onValueChange={(value) => {
                  if (value !== "text" && value !== "secret") {
                    return;
                  }
                  updateRow(row.id, { kind: value });
                }}
                size="sm"
                disabled={props.disabled}
              >
                <ToggleGroupItem value="text" size="sm">
                  Text
                </ToggleGroupItem>
                <ToggleGroupItem value="secret" size="sm">
                  Secret
                </ToggleGroupItem>
              </ToggleGroup>

              {row.kind === "secret" ? (
                <input
                  type="text"
                  list={datalistId}
                  value={row.value}
                  onChange={(e) => updateRow(row.id, { value: e.target.value })}
                  placeholder="MCP_TOKEN"
                  disabled={props.disabled}
                  spellCheck={false}
                  className="bg-modal-bg border-border-medium focus:border-accent placeholder:text-dim w-full rounded border px-2.5 py-1.5 font-mono text-[13px] text-white focus:outline-none disabled:opacity-50"
                />
              ) : (
                <input
                  type="text"
                  value={row.value}
                  onChange={(e) => updateRow(row.id, { value: e.target.value })}
                  placeholder="value"
                  disabled={props.disabled}
                  spellCheck={false}
                  className="bg-modal-bg border-border-medium focus:border-accent placeholder:text-dim w-full rounded border px-2.5 py-1.5 font-mono text-[13px] text-white focus:outline-none disabled:opacity-50"
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

      <datalist id={datalistId}>
        {props.secretKeys.map((key) => (
          <option key={key} value={key} />
        ))}
      </datalist>

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
