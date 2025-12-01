import { RepetitionDetector } from "./repetitionDetector";
import { log } from "@/node/services/log";

// Minimal interface for stream parts to avoid importing internal types
// or depending on specific AI SDK versions that might not export the union type
interface StreamPartWithText {
  type: string;
  text?: string | unknown;
}

/**
 * Wraps an AI stream with repetition detection protection.
 *
 * This is a mitigation for known Gemini model bugs where the model enters
 * an infinite loop of repeating phrases (e.g., "I am done.", "I'll do it.").
 *
 * @see https://github.com/google-gemini/gemini-cli/issues/13322
 */
export async function* withRepetitionProtection<T extends StreamPartWithText>(
  stream: AsyncIterable<T>,
  modelId: string,
  abortController: AbortController,
  workspaceId: string
): AsyncIterable<T> {
  // Only apply protection to Gemini models
  const isGemini = modelId.toLowerCase().includes("gemini") || modelId.toLowerCase().includes("google");

  if (!isGemini) {
    yield* stream;
    return;
  }

  const detector = new RepetitionDetector();

  for await (const part of stream) {
    // Check text deltas for repetition
    if (part.type === "text-delta" && typeof part.text === "string") {
      detector.addText(part.text);

      if (detector.isRepetitive()) {
        const phrase = detector.getDetectedPhrase();
        log.info("Repetitive output detected for Gemini model, aborting stream", {
          workspaceId,
          model: modelId,
          detectedPhrase: phrase,
        });

        // Abort the stream to stop upstream consumption
        abortController.abort();
        
        // Stop yielding parts immediately
        return;
      }
    }

    yield part;
  }
}
