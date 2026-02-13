import type { ProfilerOnRenderCallback } from "react";

const MAX_REACT_PROFILE_SAMPLES = 20_000;

type ReactProfilerPhase = "mount" | "update" | "nested-update";

export interface ReactRenderSample {
  id: string;
  phase: ReactProfilerPhase;
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
  interactionCount: number;
  recordedAt: number;
}

export interface ReactProfilerSummaryById {
  sampleCount: number;
  totalActualDuration: number;
  maxActualDuration: number;
  phases: Record<string, number>;
}

export interface ReactProfileSnapshot {
  enabled: boolean;
  sampleCount: number;
  droppedSampleCount: number;
  totalActualDuration: number;
  capturedAt: string;
  byProfilerId: Record<string, ReactProfilerSummaryById>;
  samples: ReactRenderSample[];
}

interface ReactProfileStore {
  samples: ReactRenderSample[];
  droppedSampleCount: number;
}

interface ReactProfilerPageApi {
  reset: () => void;
  snapshot: () => ReactProfileSnapshot;
}

declare global {
  interface Window {
    __muxReactProfileStore__?: ReactProfileStore;
    __muxReactProfiler?: ReactProfilerPageApi;
  }
}

const fallbackStore: ReactProfileStore = {
  samples: [],
  droppedSampleCount: 0,
};

function getReactProfileStore(): ReactProfileStore {
  if (typeof window === "undefined") {
    return fallbackStore;
  }

  window.__muxReactProfileStore__ ??= {
    samples: [],
    droppedSampleCount: 0,
  };

  return window.__muxReactProfileStore__;
}

export function isReactProfileCollectionEnabled(): boolean {
  return typeof window !== "undefined" && window.api?.enableReactPerfProfile === true;
}

function summarizeSamples(samples: ReactRenderSample[]): {
  totalActualDuration: number;
  byProfilerId: Record<string, ReactProfilerSummaryById>;
} {
  const byProfilerId: Record<string, ReactProfilerSummaryById> = {};
  let totalActualDuration = 0;

  for (const sample of samples) {
    totalActualDuration += sample.actualDuration;

    const existing = byProfilerId[sample.id];
    if (existing) {
      existing.sampleCount += 1;
      existing.totalActualDuration += sample.actualDuration;
      existing.maxActualDuration = Math.max(existing.maxActualDuration, sample.actualDuration);
      existing.phases[sample.phase] = (existing.phases[sample.phase] ?? 0) + 1;
      continue;
    }

    byProfilerId[sample.id] = {
      sampleCount: 1,
      totalActualDuration: sample.actualDuration,
      maxActualDuration: sample.actualDuration,
      phases: {
        [sample.phase]: 1,
      },
    };
  }

  return { totalActualDuration, byProfilerId };
}

export function getReactProfileSnapshot(): ReactProfileSnapshot {
  const store = getReactProfileStore();
  const samples = store.samples.slice();
  const summary = summarizeSamples(samples);

  return {
    enabled: isReactProfileCollectionEnabled(),
    sampleCount: samples.length,
    droppedSampleCount: store.droppedSampleCount,
    totalActualDuration: summary.totalActualDuration,
    capturedAt: new Date().toISOString(),
    byProfilerId: summary.byProfilerId,
    samples,
  };
}

export function resetReactProfileSamples(): void {
  const store = getReactProfileStore();
  store.samples = [];
  store.droppedSampleCount = 0;
}

interface ReactSampleInput {
  id: string;
  phase: ReactProfilerPhase;
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
  interactionCount?: number;
}

function appendReactSample(sample: ReactSampleInput): void {
  if (!isReactProfileCollectionEnabled()) {
    return;
  }

  const store = getReactProfileStore();
  if (store.samples.length >= MAX_REACT_PROFILE_SAMPLES) {
    store.droppedSampleCount += 1;
    return;
  }

  store.samples.push({
    ...sample,
    interactionCount: sample.interactionCount ?? 0,
    recordedAt: Date.now(),
  });
}

export function recordSyntheticReactRenderSample(sample: ReactSampleInput): void {
  appendReactSample(sample);
}

export const recordReactRenderSample: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
  baseDuration,
  startTime,
  commitTime
) => {
  appendReactSample({
    id,
    phase,
    actualDuration,
    baseDuration,
    startTime,
    commitTime,
  });
};

function ensureReactProfilerPageApi(): void {
  if (typeof window === "undefined") {
    return;
  }

  if (window.__muxReactProfiler) {
    return;
  }

  window.__muxReactProfiler = {
    reset: () => {
      resetReactProfileSamples();
    },
    snapshot: () => getReactProfileSnapshot(),
  };
}

ensureReactProfilerPageApi();
