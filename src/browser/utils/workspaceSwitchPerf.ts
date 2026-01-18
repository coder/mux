const MEASURE_NAME = "workspace_switch";
const PERF_BUFFER_LIMIT = 25;
const PENDING_SWITCH_LIMIT = 10;

interface PendingWorkspaceSwitch {
  startMark: string;
  fromWorkspaceId: string | null;
  startTime: number;
}

export interface WorkspaceSwitchMeasurement {
  workspaceId: string;
  fromWorkspaceId: string | null;
  durationMs: number;
  startTime: number;
  endTime: number;
  startMark: string;
  endMark: string;
}

declare global {
  interface Window {
    __muxPerf?: {
      workspaceSwitches: WorkspaceSwitchMeasurement[];
    };
  }
}

const pendingSwitches = new Map<string, PendingWorkspaceSwitch>();
let observerInitialized = false;

function canUsePerformance(): boolean {
  return typeof performance !== "undefined" && typeof performance.mark === "function";
}

function isPerfDebugEnabled(): boolean {
  return import.meta.env.MODE !== "production" && typeof window !== "undefined";
}

function getStartMark(workspaceId: string): string {
  return `mux:workspace-switch:start:${workspaceId}`;
}

function getEndMark(workspaceId: string): string {
  return `mux:workspace-switch:end:${workspaceId}`;
}

function getPerfBuffer(): Window["__muxPerf"] | null {
  if (!isPerfDebugEnabled()) {
    return null;
  }

  if (!window.__muxPerf) {
    window.__muxPerf = { workspaceSwitches: [] };
  } else if (!Array.isArray(window.__muxPerf.workspaceSwitches)) {
    window.__muxPerf.workspaceSwitches = [];
  }

  return window.__muxPerf;
}

function ensureObserver(): void {
  if (!isPerfDebugEnabled() || observerInitialized) {
    return;
  }

  if (typeof PerformanceObserver === "undefined") {
    return;
  }

  observerInitialized = true;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntriesByName(MEASURE_NAME)) {
      const detail = (entry as PerformanceMeasure).detail as
        | { workspaceId?: string; fromWorkspaceId?: string | null }
        | undefined;
      const workspaceId = detail?.workspaceId ?? "unknown";
      const fromWorkspaceId = detail?.fromWorkspaceId ?? "none";
      console.log(
        `[perf] ${MEASURE_NAME} ${fromWorkspaceId} → ${workspaceId}: ${entry.duration.toFixed(1)}ms`
      );
    }
  });

  try {
    observer.observe({ type: "measure", buffered: true });
  } catch {
    try {
      observer.observe({ entryTypes: ["measure"] });
    } catch {
      observerInitialized = false;
    }
  }
}

function recordMeasurement(params: {
  workspaceId: string;
  fromWorkspaceId: string | null;
  startTime: number;
  endTime: number;
  startMark: string;
  endMark: string;
}): void {
  const buffer = getPerfBuffer();
  if (!buffer) {
    return;
  }

  buffer.workspaceSwitches.push({
    workspaceId: params.workspaceId,
    fromWorkspaceId: params.fromWorkspaceId,
    durationMs: params.endTime - params.startTime,
    startTime: params.startTime,
    endTime: params.endTime,
    startMark: params.startMark,
    endMark: params.endMark,
  });

  if (buffer.workspaceSwitches.length > PERF_BUFFER_LIMIT) {
    buffer.workspaceSwitches.splice(0, buffer.workspaceSwitches.length - PERF_BUFFER_LIMIT);
  }
}

export function markWorkspaceSwitchStart(
  workspaceId: string,
  fromWorkspaceId: string | null = null
): void {
  if (!canUsePerformance()) {
    return;
  }

  ensureObserver();

  const startMark = getStartMark(workspaceId);
  const startTime = performance.now();
  pendingSwitches.set(workspaceId, { startMark, fromWorkspaceId, startTime });

  try {
    performance.mark(startMark, {
      detail: {
        workspaceId,
        fromWorkspaceId,
      },
    });
  } catch {
    pendingSwitches.delete(workspaceId);
    return;
  }

  if (pendingSwitches.size > PENDING_SWITCH_LIMIT) {
    const oldestKey = pendingSwitches.keys().next().value;
    if (oldestKey !== undefined) {
      pendingSwitches.delete(oldestKey);
    }
  }
}

export function markWorkspaceSwitchEnd(workspaceId: string): void {
  if (!canUsePerformance()) {
    return;
  }

  const pending = pendingSwitches.get(workspaceId);
  if (!pending) {
    return;
  }

  const endMark = getEndMark(workspaceId);
  const endTime = performance.now();

  try {
    performance.mark(endMark, {
      detail: {
        workspaceId,
        fromWorkspaceId: pending.fromWorkspaceId,
      },
    });
    performance.measure(MEASURE_NAME, {
      start: pending.startMark,
      end: endMark,
      detail: {
        workspaceId,
        fromWorkspaceId: pending.fromWorkspaceId,
      },
    });
  } catch {
    return;
  } finally {
    pendingSwitches.delete(workspaceId);
  }

  recordMeasurement({
    workspaceId,
    fromWorkspaceId: pending.fromWorkspaceId,
    startTime: pending.startTime,
    endTime,
    startMark: pending.startMark,
    endMark,
  });
}
