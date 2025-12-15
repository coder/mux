import React from "react";
import { SplashScreen } from "./SplashScreen";
import { useSettings } from "@/browser/contexts/SettingsContext";

export function MuxGatewaySplash({ onDismiss }: { onDismiss: () => void }) {
  const { open: openSettings } = useSettings();

  const handleOpenSettings = () => {
    openSettings("providers");
  };

  return (
    <SplashScreen
      title="Introducing Mux Gateway"
      onDismiss={onDismiss}
      primaryAction={{ label: "Open Settings", onClick: handleOpenSettings }}
    >
      <div className="text-muted" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <p>Mux Gateway gives you access to AI models through a unified API.</p>
        <p>
          If you haven&apos;t redeemed your Mux voucher yet,{" "}
          <a
            href="https://gateway.mux.coder.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
          >
            claim it here
          </a>
          .
        </p>
        <p>Once redeemed, add your coupon code in Settings → Providers → Mux Gateway.</p>
      </div>
    </SplashScreen>
  );
}
