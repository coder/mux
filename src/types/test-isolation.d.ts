declare module "*?test-isolation=static" {
  import type { useBrowserSessionSubscription } from "@/browser/features/RightSidebar/BrowserTab/useBrowserSessionSubscription";

  export const useBrowserSessionSubscription: typeof useBrowserSessionSubscription;
}
