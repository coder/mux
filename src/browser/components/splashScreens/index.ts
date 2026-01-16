import { OnboardingWizardSplash } from "./OnboardingWizardSplash";

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
  { id: "onboarding-wizard-v1", priority: 5, component: OnboardingWizardSplash },
  // Future: { id: "new-feature-xyz", priority: 2, component: NewFeatureSplash },
];

// Set to true to disable all splash screens (useful for testing)
export const DISABLE_SPLASH_SCREENS =
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment, @typescript-eslint/prefer-ts-expect-error
  // @ts-ignore - import.meta is available in Vite
  import.meta.env.MODE === "test" || (typeof window !== "undefined" && window.api?.isE2E === true);
