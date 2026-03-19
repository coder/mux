declare module "*?test-isolation=static" {
  import type { useBrowserBridgeConnection } from "@/browser/features/RightSidebar/BrowserTab/useBrowserBridgeConnection";

  export const useBrowserBridgeConnection: typeof useBrowserBridgeConnection;
}
