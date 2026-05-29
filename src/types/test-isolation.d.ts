declare module "*?test-isolation=static" {
  import type {
    BrowserTab,
    BROWSER_PREVIEW_RETRY_INTERVAL_MS,
    shouldBackOffBrowserReconnect,
  } from "@/browser/features/RightSidebar/BrowserTab/BrowserTab";
  import type { useBrowserBridgeConnection } from "@/browser/features/RightSidebar/BrowserTab/useBrowserBridgeConnection";

  export const BrowserTab: typeof BrowserTab;
  export const BROWSER_PREVIEW_RETRY_INTERVAL_MS: typeof BROWSER_PREVIEW_RETRY_INTERVAL_MS;
  export const shouldBackOffBrowserReconnect: typeof shouldBackOffBrowserReconnect;
  export const useBrowserBridgeConnection: typeof useBrowserBridgeConnection;
}
