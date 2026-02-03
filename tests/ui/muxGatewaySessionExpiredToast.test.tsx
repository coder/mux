import "./dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";

import { installDom } from "./dom";

import { MuxGatewaySessionExpiredToast } from "@/browser/components/MuxGatewaySessionExpiredToast";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { MUX_GATEWAY_SESSION_EXPIRED_MESSAGE } from "@/common/constants/muxGatewayOAuth";

describe("MuxGatewaySessionExpiredToast", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("shows a PopoverError when mux gateway session expires", async () => {
    const view = render(<MuxGatewaySessionExpiredToast />);

    window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.MUX_GATEWAY_SESSION_EXPIRED));

    await waitFor(() => {
      expect(view.getByText(MUX_GATEWAY_SESSION_EXPIRED_MESSAGE)).toBeTruthy();
    });
  });
});
