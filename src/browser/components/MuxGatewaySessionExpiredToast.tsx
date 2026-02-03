import { useEffect } from "react";
import { PopoverError } from "@/browser/components/PopoverError";
import { usePopoverError } from "@/browser/hooks/usePopoverError";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { MUX_GATEWAY_SESSION_EXPIRED_MESSAGE } from "@/common/constants/muxGatewayOAuth";

export function MuxGatewaySessionExpiredToast() {
  const { error, showError, clearError } = usePopoverError(7000);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handler = () => {
      showError("mux-gateway-session-expired", MUX_GATEWAY_SESSION_EXPIRED_MESSAGE);
    };

    window.addEventListener(CUSTOM_EVENTS.MUX_GATEWAY_SESSION_EXPIRED, handler as EventListener);
    return () => {
      window.removeEventListener(
        CUSTOM_EVENTS.MUX_GATEWAY_SESSION_EXPIRED,
        handler as EventListener
      );
    };
  }, [showError]);

  return <PopoverError error={error} prefix="Mux Gateway" onDismiss={clearError} />;
}
