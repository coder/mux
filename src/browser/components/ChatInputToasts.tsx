import React from "react";
import type { Toast } from "./ChatInputToast";
import { SolutionLabel } from "./ChatInputToast";
import { DocsLink } from "./DocsLink";
import type { ParsedCommand } from "@/browser/utils/slashCommands/types";
import type { SendMessageError as SendMessageErrorType } from "@/common/types/errors";
import { formatSendMessageError } from "@/common/utils/errors/formatSendError";

export function createInvalidCompactModelToast(model: string): Toast {
  return {
    id: Date.now().toString(),
    type: "error",
    title: "Invalid Model",
    message: `Invalid model format: "${model}". Use an alias or provider:model-id.`,
    solution: (
      <>
        <SolutionLabel>Try an alias:</SolutionLabel>
        /compact -m sonnet
        <br />
        /compact -m gpt
        <br />
        <br />
        <SolutionLabel>Supported models:</SolutionLabel>
        <DocsLink path="/config/models">mux.coder.com/models</DocsLink>
      </>
    ),
  };
}

/**
 * Creates a toast message for command-related errors and help messages
 */
export const createCommandToast = (parsed: ParsedCommand): Toast | null => {
  if (!parsed) return null;

  switch (parsed.type) {
    case "providers-help":
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Providers Command",
        message: "Configure AI provider settings",
        solution: (
          <>
            <SolutionLabel>Usage:</SolutionLabel>
            /providers set &lt;provider&gt; &lt;key&gt; &lt;value&gt;
            <br />
            <br />
            <SolutionLabel>Example:</SolutionLabel>
            /providers set anthropic apiKey YOUR_API_KEY
          </>
        ),
      };

    case "providers-missing-args": {
      const missing =
        parsed.argCount === 0
          ? "provider, key, and value"
          : parsed.argCount === 1
            ? "key and value"
            : parsed.argCount === 2
              ? "value"
              : "";

      return {
        id: Date.now().toString(),
        type: "error",
        title: "Missing Arguments",
        message: `Missing ${missing} for /providers set`,
        solution: (
          <>
            <SolutionLabel>Usage:</SolutionLabel>
            /providers set &lt;provider&gt; &lt;key&gt; &lt;value&gt;
          </>
        ),
      };
    }

    case "providers-invalid-subcommand":
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Invalid Subcommand",
        message: `Invalid subcommand '${parsed.subcommand}'`,
        solution: (
          <>
            <SolutionLabel>Available Commands:</SolutionLabel>
            /providers set - Configure provider settings
          </>
        ),
      };

    case "model-help":
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Model Command",
        message: "Select AI model for this session",
        solution: (
          <>
            <SolutionLabel>Usage:</SolutionLabel>
            /model &lt;abbreviation&gt; or /model &lt;provider:model&gt;
            <br />
            <br />
            <SolutionLabel>Examples:</SolutionLabel>
            /model sonnet
            <br />
            /model anthropic:opus-4-1
          </>
        ),
      };

    case "fork-help":
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Fork Command",
        message: "Fork current workspace with a new name",
        solution: (
          <>
            <SolutionLabel>Usage:</SolutionLabel>
            /fork &lt;new-name&gt; [optional start message]
            <br />
            <br />
            <SolutionLabel>Examples:</SolutionLabel>
            /fork experiment-branch
            <br />
            /fork refactor Continue with refactoring approach
          </>
        ),
      };

    case "command-missing-args":
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Missing Arguments",
        message: `/${parsed.command} requires arguments`,
        solution: (
          <>
            <SolutionLabel>Usage:</SolutionLabel>
            {parsed.usage}
          </>
        ),
      };

    case "command-invalid-args":
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Invalid Argument",
        message: `'${parsed.input}' is not valid for /${parsed.command}`,
        solution: (
          <>
            <SolutionLabel>Usage:</SolutionLabel>
            {parsed.usage}
          </>
        ),
      };

    case "unknown-command": {
      const cmd = "/" + parsed.command + (parsed.subcommand ? " " + parsed.subcommand : "");
      return {
        id: Date.now().toString(),
        type: "error",
        message: `Unknown command: ${cmd}`,
      };
    }

    default:
      return null;
  }
};

/**
 * Converts a SendMessageError to a Toast for display
 */
export const createErrorToast = (error: SendMessageErrorType): Toast => {
  switch (error.type) {
    case "api_key_not_found": {
      const formatted = formatSendMessageError(error);
      return {
        id: Date.now().toString(),
        type: "error",
        title: "API Key Not Found",
        message: `The ${error.provider} provider requires an API key to function.`,
        solution: formatted.providerCommand ? (
          <>
            <SolutionLabel>Quick Fix:</SolutionLabel>
            {formatted.providerCommand}
          </>
        ) : undefined,
      };
    }

    case "provider_not_supported": {
      const formatted = formatSendMessageError(error);
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Provider Not Supported",
        message: formatted.message,
        solution: (
          <>
            <SolutionLabel>Try This:</SolutionLabel>
            Use an available provider from /providers list
          </>
        ),
      };
    }

    case "invalid_model_string": {
      const formatted = formatSendMessageError(error);
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Invalid Model Format",
        message: formatted.message,
        solution: (
          <>
            <SolutionLabel>Expected Format:</SolutionLabel>
            provider:model-name (e.g., anthropic:claude-opus-4-1)
          </>
        ),
      };
    }

    case "incompatible_workspace": {
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Incompatible Workspace",
        message: error.message,
        solution: (
          <>
            <SolutionLabel>Solution:</SolutionLabel>
            Upgrade mux to use this workspace, or delete it and create a new one.
          </>
        ),
      };
    }

    case "unknown":
    default: {
      const formatted = formatSendMessageError(error);
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Message Send Failed",
        message: formatted.message,
      };
    }
  }
};
