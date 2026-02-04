import { useEffect, useState } from "react";
import { SplashScreen } from "@/browser/components/splashScreens/SplashScreen";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { MUX_GATEWAY_SESSION_EXPIRED_MESSAGE } from "@/common/constants/muxGatewayOAuth";

export function MuxGatewaySessionExpiredDialog() {
  const { open: openSettings } = useSettings();
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handler = () => {
      setIsOpen(true);
    };

    window.addEventListener(CUSTOM_EVENTS.MUX_GATEWAY_SESSION_EXPIRED, handler as EventListener);
    return () => {
      window.removeEventListener(
        CUSTOM_EVENTS.MUX_GATEWAY_SESSION_EXPIRED,
        handler as EventListener
      );
    };
  }, []);

  if (!isOpen) {
    return null;
  }

  return (
    <SplashScreen
      title="Mux Gateway session expired"
      onDismiss={() => setIsOpen(false)}
      primaryAction={{
        label: "Login to mux gateway",
        onClick: () => {
          openSettings("providers", { expandProvider: "mux-gateway" });
        },
      }}
      dismissLabel="Cancel"
    >
      <p className="text-muted text-sm">{MUX_GATEWAY_SESSION_EXPIRED_MESSAGE}</p>
    </SplashScreen>
  );
}
