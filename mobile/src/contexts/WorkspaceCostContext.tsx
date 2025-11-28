import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import { sumUsageHistory } from "@/common/utils/tokens/usageAggregator";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import type { ChatStats } from "@/common/types/chatStats.ts";
import type { MuxMessage } from "@/common/types/message.ts";
import type { WorkspaceChatMessage } from "@/common/types/ipc";
import { isMuxMessage, isStreamEnd } from "@/common/types/ipc";
import type { StreamEndEvent, StreamAbortEvent } from "@/common/types/stream.ts";

import type { WorkspaceChatEvent } from "../types";
import { useApiClient } from "../hooks/useApiClient";

interface UsageEntry {
  messageId: string;
  usage: ChatUsageDisplay;
  historySequence: number;
  timestamp: number;
}

interface ConsumerReadyState {
  status: "ready";
  stats: ChatStats;
}

interface ConsumerLoadingState {
  status: "loading";
}

interface ConsumerErrorState {
  status: "error";
  error: string;
}

interface ConsumerIdleState {
  status: "idle";
}

type ConsumerState =
  | ConsumerReadyState
  | ConsumerLoadingState
  | ConsumerErrorState
  | ConsumerIdleState;

interface WorkspaceCostContextValue {
  usageHistory: ChatUsageDisplay[];
  lastUsage: ChatUsageDisplay | undefined;
  sessionUsage: ChatUsageDisplay | undefined;
  totalTokens: number;
  isInitialized: boolean;
  consumers: ConsumerState;
  refreshConsumers: () => Promise<void>;
  recordStreamUsage: (event: StreamEndEvent | StreamAbortEvent) => void;
}

const WorkspaceCostContext = createContext<WorkspaceCostContextValue | null>(null);

function normalizeUsage(
  messageId: string,
  metadata: {
    usage?: LanguageModelV2Usage;
    model?: string;
    providerMetadata?: Record<string, unknown>;
    historySequence?: number;
    timestamp?: number;
  }
): UsageEntry | null {
  if (!metadata.usage) {
    return null;
  }

  const model =
    typeof metadata.model === "string" && metadata.model.length > 0 ? metadata.model : "unknown";
  const display = createDisplayUsage(metadata.usage, model, metadata.providerMetadata);
  if (!display) {
    return null;
  }

  const usage: ChatUsageDisplay = {
    ...display,
    model: display.model ?? model,
  };

  const historySequence =
    typeof metadata.historySequence === "number" && Number.isFinite(metadata.historySequence)
      ? metadata.historySequence
      : Number.MAX_SAFE_INTEGER;
  const timestamp =
    typeof metadata.timestamp === "number" && Number.isFinite(metadata.timestamp)
      ? metadata.timestamp
      : Date.now();

  return {
    messageId,
    usage,
    historySequence,
    timestamp,
  };
}

function sortEntries(entries: Iterable<UsageEntry>): ChatUsageDisplay[] {
  return Array.from(entries)
    .sort((a, b) => {
      if (a.historySequence !== b.historySequence) {
        return a.historySequence - b.historySequence;
      }
      if (a.timestamp !== b.timestamp) {
        return a.timestamp - b.timestamp;
      }
      return a.messageId.localeCompare(b.messageId);
    })
    .map((entry) => entry.usage);
}

function extractMessagesFromReplay(events: WorkspaceChatEvent[]): MuxMessage[] {
  const messages: MuxMessage[] = [];
  for (const event of events) {
    if (isMuxMessage(event as unknown as WorkspaceChatMessage)) {
      messages.push(event as unknown as MuxMessage);
    }
  }
  return messages;
}

function getLastModel(messages: MuxMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = messages[i]?.metadata?.model;
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}

export function WorkspaceCostProvider({
  workspaceId,
  children,
}: {
  workspaceId?: string | null;
  children: ReactNode;
}): JSX.Element {
  const api = useApiClient();
  const usageMapRef = useRef<Map<string, UsageEntry>>(new Map());
  const [usageHistory, setUsageHistory] = useState<ChatUsageDisplay[]>([]);
  const [isInitialized, setIsInitialized] = useState(false);

  // Check if we're in creation mode (no workspaceId yet)
  const isCreationMode = !workspaceId;
  const [consumers, setConsumers] = useState<ConsumerState>({ status: "idle" });

  useEffect(() => {
    let isCancelled = false;
    usageMapRef.current = new Map();
    setUsageHistory([]);
    setConsumers({ status: "idle" });
    setIsInitialized(false);

    // Skip loading in creation mode (no workspace yet)
    if (isCreationMode) {
      setIsInitialized(true);
      return;
    }

    void (async () => {
      try {
        const events = await api.workspace.getFullReplay(workspaceId!);
        if (isCancelled) {
          return;
        }

        const nextMap = new Map<string, UsageEntry>();
        for (const event of events) {
          if (isMuxMessage(event as unknown as WorkspaceChatMessage)) {
            const message = event as unknown as MuxMessage;
            const entry = normalizeUsage(message.id, {
              usage: message.metadata?.usage,
              model: message.metadata?.model,
              providerMetadata: message.metadata?.providerMetadata,
              historySequence: message.metadata?.historySequence,
              timestamp: message.metadata?.timestamp,
            });
            if (entry) {
              nextMap.set(entry.messageId, entry);
            }
          } else if (isStreamEnd(event as unknown as WorkspaceChatMessage)) {
            const stream = event as unknown as StreamEndEvent;
            const entry = normalizeUsage(stream.messageId, {
              usage: stream.metadata?.usage,
              model: stream.metadata?.model,
              providerMetadata: stream.metadata?.providerMetadata,
              historySequence: stream.metadata?.historySequence,
              timestamp: stream.metadata?.timestamp,
            });
            if (entry) {
              nextMap.set(entry.messageId, entry);
            }
          }
        }

        usageMapRef.current = nextMap;
        setUsageHistory(sortEntries(nextMap.values()));
      } catch (error) {
        console.error("[WorkspaceCostProvider] Failed to load initial usage:", error);
      } finally {
        if (!isCancelled) {
          setIsInitialized(true);
        }
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [api, workspaceId, isCreationMode]);

  const registerUsage = useCallback((entry: UsageEntry | null) => {
    if (!entry) {
      return;
    }
    const map = new Map(usageMapRef.current);
    map.set(entry.messageId, entry);
    usageMapRef.current = map;
    setUsageHistory(sortEntries(map.values()));
  }, []);

  const recordStreamUsage = useCallback(
    (event: StreamEndEvent | StreamAbortEvent) => {
      if (event.type === "stream-end") {
        registerUsage(
          normalizeUsage(event.messageId, {
            usage: event.metadata?.usage,
            model: event.metadata?.model,
            providerMetadata: event.metadata?.providerMetadata,
            historySequence: event.metadata?.historySequence,
            timestamp: event.metadata?.timestamp,
          })
        );
        return;
      }

      if (event.type === "stream-abort" && event.metadata?.usage) {
        registerUsage(
          normalizeUsage(event.messageId, {
            usage: event.metadata.usage,
            model: undefined,
            historySequence: undefined,
            timestamp: Date.now(),
          })
        );
      }
    },
    [registerUsage]
  );

  const refreshConsumers = useCallback(async () => {
    // Skip in creation mode
    if (isCreationMode) {
      return;
    }

    setConsumers((prev) => {
      if (prev.status === "loading") {
        return prev;
      }
      return { status: "loading" };
    });

    try {
      const events = await api.workspace.getFullReplay(workspaceId!);
      const messages = extractMessagesFromReplay(events);
      if (messages.length === 0) {
        setConsumers({
          status: "ready",
          stats: {
            consumers: [],
            totalTokens: 0,
            tokenizerName: "",
            model: "unknown",
            usageHistory: [],
          } as ChatStats,
        });
        return;
      }

      const model = getLastModel(messages) ?? "unknown";
      const stats = await api.tokenizer.calculateStats(messages, model);
      setConsumers({ status: "ready", stats });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setConsumers({ status: "error", error: message });
    }
  }, [api, workspaceId, isCreationMode]);

  const lastUsage = usageHistory.length > 0 ? usageHistory[usageHistory.length - 1] : undefined;
  const sessionUsage = useMemo(() => sumUsageHistory(usageHistory), [usageHistory]);
  const totalTokens = useMemo(() => {
    if (!sessionUsage) {
      return 0;
    }
    return (
      sessionUsage.input.tokens +
      sessionUsage.cached.tokens +
      sessionUsage.cacheCreate.tokens +
      sessionUsage.output.tokens +
      sessionUsage.reasoning.tokens
    );
  }, [sessionUsage]);

  const value = useMemo<WorkspaceCostContextValue>(
    () => ({
      usageHistory,
      lastUsage,
      sessionUsage,
      totalTokens,
      isInitialized,
      consumers,
      refreshConsumers,
      recordStreamUsage,
    }),
    [
      usageHistory,
      lastUsage,
      sessionUsage,
      totalTokens,
      isInitialized,
      consumers,
      refreshConsumers,
      recordStreamUsage,
    ]
  );

  return <WorkspaceCostContext.Provider value={value}>{children}</WorkspaceCostContext.Provider>;
}

export function useWorkspaceCost(): WorkspaceCostContextValue {
  const ctx = useContext(WorkspaceCostContext);
  if (!ctx) {
    throw new Error("useWorkspaceCost must be used within WorkspaceCostProvider");
  }
  return ctx;
}
