/**
 * Creates a compacted summary message for "Start from Here" functionality.
 * This message will replace all chat history.
 */
export function createCompactedMessage(content: string) {
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(2, 11);

  return {
    id: `start-here-${timestamp}-${randomSuffix}`,
    role: "assistant" as const,
    parts: [
      {
        type: "text" as const,
        text: content,
        state: "done" as const,
      },
    ],
    metadata: {
      timestamp,
      compacted: true as const,
    },
  };
}
