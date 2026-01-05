import { MuxGatewaySplash } from "./MuxGateway";

export interface SplashConfig {
  id: string;
  priority: number;
  component: React.FC<{ onDismiss: () => void }>;
}

// Add new splash screens here
// Priority 0 = Never show
// Priority 1 = Lowest priority
// Priority 2 = Medium priority
// Priority 3+ = Higher priority (shown first)
export const SPLASH_REGISTRY: SplashConfig[] = [
  { id: "mux-gateway-intro", priority: 3, component: MuxGatewaySplash },
  // Future: { id: "new-feature-xyz", priority: 2, component: NewFeatureSplash },
];

// Set to true to disable all splash screens (useful for testing)
export const DISABLE_SPLASH_SCREENS = true;
