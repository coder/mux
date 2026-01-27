import type { Logger } from "@/node/services/log";

export interface StreamErrorInfo {
  label: string;
  code?: string;
  message: string;
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === "string") {
    return new Error(error);
  }

  return new Error("Unknown error");
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  if ("code" in error && typeof error.code === "string") {
    return error.code;
  }

  return undefined;
}

export function isIgnorableStreamError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === "EPIPE" || code === "ECONNRESET";
}

export interface StreamErrorHandlerOptions {
  logger?: Pick<Logger, "debug" | "warn">;
  onIgnorable?: (error: Error, info: StreamErrorInfo) => void;
  onUnexpected?: (error: Error, info: StreamErrorInfo) => void;
}

export function attachStreamErrorHandler(
  emitter: NodeJS.EventEmitter,
  label: string,
  options: StreamErrorHandlerOptions = {}
): () => void {
  const handler = (error: unknown) => {
    const normalized = normalizeError(error);
    const info: StreamErrorInfo = {
      label,
      code: getErrorCode(error),
      message: normalized.message,
    };

    if (isIgnorableStreamError(error)) {
      options.logger?.debug("Ignored stream error", info, normalized);
      options.onIgnorable?.(normalized, info);
      return;
    }

    options.logger?.warn("Stream error", info, normalized);
    options.onUnexpected?.(normalized, info);
  };

  emitter.on("error", handler);

  return () => {
    emitter.removeListener("error", handler);
  };
}
