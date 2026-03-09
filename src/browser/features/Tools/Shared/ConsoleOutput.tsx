import React from "react";
import type { ConsoleRecord } from "./codeExecutionTypes";

interface ConsoleOutputDisplayProps {
  output: ConsoleRecord[];
}

// Use CSS variables from globals.css
const levelStyles: Record<string, React.CSSProperties> = {
  log: { color: "var(--color-muted-foreground)" },
  warn: { color: "var(--color-warning, #f59e0b)" },
  error: { color: "var(--color-error, #ef4444)" },
};

export const ConsoleOutputDisplay: React.FC<ConsoleOutputDisplayProps> = ({ output }) => {
  return (
    <div className="space-y-0.5 font-mono text-[11px]">
      {output.map((record, i) => (
        <div key={i} className="flex gap-2" style={levelStyles[record.level]}>
          <span className="opacity-60">[{record.level}]</span>
          <span>
            {record.args.map((arg, j) => {
              // Handle all types to avoid Object.toString() issues
              let display: string;
              if (arg === null) {
                display = "null";
              } else if (arg === undefined) {
                display = "undefined";
              } else if (typeof arg === "string") {
                display = arg;
              } else if (typeof arg === "number" || typeof arg === "boolean") {
                display = String(arg);
              } else {
                // objects, arrays, symbols, functions - JSON.stringify handles them all
                display = JSON.stringify(arg);
              }
              return (
                <span key={j}>
                  {display}
                  {j < record.args.length - 1 ? " " : ""}
                </span>
              );
            })}
          </span>
        </div>
      ))}
    </div>
  );
};
