import { describe, expect, test } from "@jest/globals";
import { createErrorToast } from "./ChatInputToasts";
import type { SendMessageError } from "@/common/types/errors";

describe("ChatInputToasts", () => {
  describe("createErrorToast", () => {
    test("should create toast for api_key_not_found error", () => {
      const error: SendMessageError = {
        type: "api_key_not_found",
        provider: "openai",
      };

      const toast = createErrorToast(error);

      expect(toast.type).toBe("error");
      expect(toast.title).toBe("API Key Not Found");
      expect(toast.message).toContain("openai");
      expect(toast.message).toContain("API key");
    });

    test("should create toast for provider_not_supported error", () => {
      const error: SendMessageError = {
        type: "provider_not_supported",
        provider: "custom-provider",
      };

      const toast = createErrorToast(error);

      expect(toast.type).toBe("error");
      expect(toast.title).toBe("Provider Not Supported");
      expect(toast.message).toContain("custom-provider");
    });

    test("should create toast for invalid_model_string error", () => {
      const error: SendMessageError = {
        type: "invalid_model_string",
        message: "Invalid format: expected provider:model",
      };

      const toast = createErrorToast(error);

      expect(toast.type).toBe("error");
      expect(toast.title).toBe("Invalid Model Format");
      expect(toast.message).toBe("Invalid format: expected provider:model");
    });

    test("should create toast for unknown error with message", () => {
      const error: SendMessageError = {
        type: "unknown",
        raw: "Network connection failed",
      };

      const toast = createErrorToast(error);

      expect(toast.type).toBe("error");
      expect(toast.title).toBe("Message Send Failed");
      expect(toast.message).toBe("Network connection failed");
    });

    test("should create toast for unknown error without message", () => {
      const error: SendMessageError = {
        type: "unknown",
        raw: "",
      };

      const toast = createErrorToast(error);

      expect(toast.type).toBe("error");
      expect(toast.title).toBe("Message Send Failed");
      expect(toast.message).toContain("unexpected error");
    });
  });
});
