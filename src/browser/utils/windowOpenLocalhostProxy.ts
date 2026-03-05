import { normalizeLocalhostProxyUrl } from "@/common/utils/localhostProxyUrl";
import { resolveBrowserLocalhostProxyTemplate } from "./browserLocalhostProxyTemplate";

let windowOpenProxyNormalizationInstalled = false;

/**
 * Install a one-time wrapper around window.open() so localhost/loopback URLs can
 * be normalized through browser-mode proxy templates when available.
 */
export function installWindowOpenLocalhostProxyNormalization(): void {
  if (windowOpenProxyNormalizationInstalled) {
    return;
  }

  const originalWindowOpen = window.open.bind(window);
  const wrappedWindowOpen: typeof window.open = (url, target, features) => {
    const urlString =
      typeof url === "string" ? url : url instanceof URL ? url.toString() : undefined;

    const normalizedUrl =
      urlString == null
        ? urlString
        : normalizeLocalhostProxyUrl({
            url: urlString,
            localhostProxyTemplate: resolveBrowserLocalhostProxyTemplate({
              injectedTemplate: window.__MUX_PROXY_URI_TEMPLATE__,
              browserProtocol: window.location.protocol,
              browserHostname: window.location.hostname,
              browserPort: window.location.port,
            }),
            browserHost: window.location.host,
          });

    return originalWindowOpen(normalizedUrl, target, features);
  };

  window.open = wrappedWindowOpen;
  windowOpenProxyNormalizationInstalled = true;
}
