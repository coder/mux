import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { getVscodeBridge } from "./vscodeBridge";

const bridge = getVscodeBridge();

const rootEl = document.getElementById("root");
if (!rootEl) {
  bridge.debugLog("fatal: missing #root element");
  throw new Error("mux webview: missing #root element");
}

createRoot(rootEl).render(
  <React.StrictMode>
    <App bridge={bridge} />
  </React.StrictMode>
);
