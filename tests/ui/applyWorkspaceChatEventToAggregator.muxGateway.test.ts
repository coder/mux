import "./dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { installDom } from "./dom";

import { applyWorkspaceChatEventToAggregator } from "@/browser/utils/messages/applyWorkspaceChatEventToAggregator";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { GATEWAY_CONFIGURED_KEY } from "@/common/constants/storage";
import { MUX_GATEWAY_SESSION_EXPIRED_MESSAGE } from "@/common/constants/muxGatewayOAuth";
import type { StreamErrorMessage } from "@/common/orpc/types";

const stubAggregator = {
  handleStreamStart: () => {},
  handleStreamDelta: () => {},
  handleStreamEnd: () => {},
  handleStreamAbort: () => {},
  handleStreamError: () => {},

  handleToolCallStart: () => {},
  handleToolCallDelta: () => {},
  handleToolCallEnd: () => {},

  handleReasoningDelta: () => {},
  handleReasoningEnd: () => {},

  handleUsageDelta: () => {},

  handleDeleteMessage: () => {},

  handleMessage: () => {},

  handleRuntimeStatus: () => {},

  clearTokenState: () => {},
};

describe("applyWorkspaceChatEventToAggregator (Mux Gateway session expiry)", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanupDom?.();
    cleanupDom = null;
  });

  test("disables gateway routing and dispatches event for session-expired stream errors", () => {
    updatePersistedState(GATEWAY_CONFIGURED_KEY, true);

    let dispatchCount = 0;
    window.addEventListener(CUSTOM_EVENTS.MUX_GATEWAY_SESSION_EXPIRED, () => {
      dispatchCount += 1;
    });

    const event: StreamErrorMessage = {
      type: "stream-error",
      messageId: "test-message",
      error: MUX_GATEWAY_SESSION_EXPIRED_MESSAGE,
      errorType: "authentication",
    };

    const hint = applyWorkspaceChatEventToAggregator(stubAggregator, event);

    expect(hint).toBe("immediate");
    expect(readPersistedState(GATEWAY_CONFIGURED_KEY, true)).toBe(false);
    expect(dispatchCount).toBe(1);
  });
});
