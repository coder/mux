import type { Config } from "@/node/config";
import type { Result } from "@/common/types/result";

/**
 * Voice input service using OpenAI's Whisper API for transcription.
 */
export class VoiceService {
  constructor(private readonly config: Config) {}

  /**
   * Transcribe audio from base64-encoded data using OpenAI's Whisper API.
   * @param audioBase64 Base64-encoded audio data
   * @returns Transcribed text or error
   */
  async transcribe(audioBase64: string): Promise<Result<string, string>> {
    try {
      // Get OpenAI API key from config
      const providersConfig = this.config.loadProvidersConfig() ?? {};
      const openaiConfig = providersConfig.openai as { apiKey?: string } | undefined;
      const apiKey = openaiConfig?.apiKey;

      if (!apiKey) {
        return {
          success: false,
          error: "OpenAI API key not configured. Go to Settings → Providers to add your key.",
        };
      }

      // Decode base64 to binary
      const binaryString = atob(audioBase64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const audioBlob = new Blob([bytes], { type: "audio/webm" });

      // Create form data for OpenAI API
      const formData = new FormData();
      formData.append("file", audioBlob, "audio.webm");
      formData.append("model", "whisper-1");
      formData.append("response_format", "text");

      // Call OpenAI Whisper API
      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `Transcription failed: ${response.status}`;
        try {
          const errorJson = JSON.parse(errorText) as { error?: { message?: string } };
          if (errorJson.error?.message) {
            errorMessage = errorJson.error.message;
          }
        } catch {
          // Use raw error text if JSON parsing fails
          if (errorText) {
            errorMessage = errorText;
          }
        }
        return { success: false, error: errorMessage };
      }

      const text = await response.text();
      return { success: true, data: text };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Transcription failed: ${message}` };
    }
  }
}
