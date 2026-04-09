import { describe, expect, test } from "bun:test";

import {
  areRuntimeStatusEventsEqual,
  areStreamLifecycleSnapshotsEqual,
  copyRuntimeStatusEvent,
  hasInFlightStreamLifecycle,
  isTerminalRuntimeStatusPhase,
} from "./stream";

describe("stream shared helpers", () => {
  test("compare stream lifecycle snapshots with nullish abort reasons", () => {
    expect(
      areStreamLifecycleSnapshotsEqual(
        { phase: "failed", hadAnyOutput: false },
        { phase: "failed", hadAnyOutput: false }
      )
    ).toBe(true);

    expect(
      areStreamLifecycleSnapshotsEqual(
        { phase: "failed", hadAnyOutput: false, abortReason: "user" },
        { phase: "failed", hadAnyOutput: false }
      )
    ).toBe(false);
  });

  test("copy runtime-status events and compare optional fields nullishly", () => {
    const copied = copyRuntimeStatusEvent({
      type: "runtime-status",
      workspaceId: "ws-1",
      phase: "starting",
      runtimeType: "ssh",
      detail: "Checking workspace runtime...",
    });

    expect(copied).toEqual({
      type: "runtime-status",
      workspaceId: "ws-1",
      phase: "starting",
      runtimeType: "ssh",
      detail: "Checking workspace runtime...",
    });
    expect(copied).not.toBe(copyRuntimeStatusEvent(copied));
    expect("source" in copied).toBe(false);

    expect(
      areRuntimeStatusEventsEqual(copied, {
        phase: "starting",
        runtimeType: "ssh",
        detail: "Checking workspace runtime...",
      })
    ).toBe(true);
    expect(
      areRuntimeStatusEventsEqual(copied, {
        phase: "starting",
        runtimeType: "ssh",
        detail: "Loading tools...",
      })
    ).toBe(false);
  });

  test("share terminal runtime-status and in-flight lifecycle semantics", () => {
    expect(isTerminalRuntimeStatusPhase("ready")).toBe(true);
    expect(isTerminalRuntimeStatusPhase("error")).toBe(true);
    expect(isTerminalRuntimeStatusPhase("starting")).toBe(false);

    expect(hasInFlightStreamLifecycle({ phase: "preparing" })).toBe(true);
    expect(hasInFlightStreamLifecycle({ phase: "streaming" })).toBe(true);
    expect(hasInFlightStreamLifecycle({ phase: "completing" })).toBe(true);
    expect(hasInFlightStreamLifecycle({ phase: "failed" })).toBe(false);
    expect(hasInFlightStreamLifecycle({ phase: "interrupted" })).toBe(false);
    expect(hasInFlightStreamLifecycle(null)).toBe(false);
  });
});
