import { MuxGatewaySplash } from "./muxGateway";

export interface SplashConfig {
  id: string;
  priority: number;
  component: React.FC<{ onDismiss: () => void }>;
}

// Add new splash screens here
// Priority 1 = highest priority (shown first)
// Priority 2 = lower priority (shown second), etc.
export const SPLASH_REGISTRY: SplashConfig[] = [
  { id: "mux-gateway-intro", priority: 1, component: MuxGatewaySplash },
  // Future: { id: "new-feature-xyz", priority: 2, component: NewFeatureSplash },
];
