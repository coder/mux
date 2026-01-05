import type { JSX, ReactNode } from "react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { BASH_TRUNCATE_MAX_TOTAL_BYTES } from "@/common/constants/toolLimits";
import {
  appendLiveBashOutputChunk,
  toLiveBashOutputView,
  type LiveBashOutputInternal,
  type LiveBashOutputView,
} from "@/browser/utils/messages/liveBashOutputBuffer";
import { assert } from "../utils/assert";

type Listener = () => void;

class LiveBashOutputStore {
  private readonly outputs = new Map<string, LiveBashOutputInternal>();
  private readonly listeners = new Map<string, Set<Listener>>();

  appendChunk(toolCallId: string, chunk: { text: string; isError: boolean }): void {
    assert(toolCallId.length > 0, "appendChunk requires a toolCallId");

    const prev = this.outputs.get(toolCallId);
    const next = appendLiveBashOutputChunk(prev, chunk, BASH_TRUNCATE_MAX_TOTAL_BYTES);
    this.outputs.set(toolCallId, next);
    this.emit(toolCallId);
  }

  clear(toolCallId: string): void {
    if (!this.outputs.has(toolCallId)) {
      return;
    }
    this.outputs.delete(toolCallId);
    this.emit(toolCallId);
  }

  getView(toolCallId: string): LiveBashOutputView | undefined {
    const state = this.outputs.get(toolCallId);
    return state ? toLiveBashOutputView(state) : undefined;
  }

  subscribe(toolCallId: string, listener: Listener): () => void {
    const set = this.listeners.get(toolCallId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(toolCallId, set);

    return () => {
      const current = this.listeners.get(toolCallId);
      if (!current) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(toolCallId);
      }
    };
  }

  private emit(toolCallId: string): void {
    const set = this.listeners.get(toolCallId);
    if (!set) {
      return;
    }
    for (const listener of set) {
      try {
        listener();
      } catch (error) {
        console.error("[LiveBashOutputStore] listener threw", error);
      }
    }
  }
}

const LiveBashOutputContext = createContext<LiveBashOutputStore | null>(null);

export function LiveBashOutputProvider({ children }: { children: ReactNode }): JSX.Element {
  const storeRef = useRef<LiveBashOutputStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = new LiveBashOutputStore();
  }

  return (
    <LiveBashOutputContext.Provider value={storeRef.current}>
      {children}
    </LiveBashOutputContext.Provider>
  );
}

export function useLiveBashOutputStore(): LiveBashOutputStore {
  const store = useContext(LiveBashOutputContext);
  if (!store) {
    throw new Error("useLiveBashOutputStore must be used within LiveBashOutputProvider");
  }
  return store;
}

export function useLiveBashOutputView(toolCallId: string | undefined): LiveBashOutputView | null {
  const store = useLiveBashOutputStore();
  const [, forceRender] = useState(0);

  useEffect(() => {
    if (!toolCallId) {
      return undefined;
    }

    return store.subscribe(toolCallId, () => {
      forceRender((v) => v + 1);
    });
  }, [store, toolCallId]);

  if (!toolCallId) {
    return null;
  }

  return store.getView(toolCallId) ?? null;
}
