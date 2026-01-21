import React from "react";
import { AlertTriangle } from "lucide-react";

interface ErrorMessageProps {
  title?: string;
  message: string;
  details?: string;
}

export const ErrorMessage: React.FC<ErrorMessageProps> = ({ title, message, details }) => {
  return (
    <div className="bg-error-bg text-error border-error my-2 rounded border p-3 font-mono text-sm leading-relaxed break-words whitespace-pre-wrap">
      {title && (
        <div className="mb-2 flex items-center gap-2 font-bold">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          {title}
        </div>
      )}
      <div>{message}</div>
      {details && <div className="opacity-90">{details}</div>}
    </div>
  );
};
