import { createContext } from "react";

interface StreamingContextValue {
  isStreaming: boolean;
}

export const StreamingContext = createContext<StreamingContextValue>({
  isStreaming: false,
});
