/**
 * Global setup for jsdom environment - runs before ANY imports.
 * Must be JS (not TS) to avoid transpilation issues.
 */

// Mock import.meta.env for Vite compatibility
// This needs to be set before any imports that use it

// Polyfill ResizeObserver for Radix/layout components in jsdom
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
// Default to a desktop viewport so mobile-only behavior (like auto-collapsing the sidebar)
// doesn't interfere with UI integration tests.
try {
  Object.defineProperty(globalThis, "innerWidth", { value: 1024, writable: true });
  Object.defineProperty(globalThis, "innerHeight", { value: 768, writable: true });
} catch {
  // ignore
}

globalThis.import_meta_env = {
  VITE_BACKEND_URL: undefined,
  MODE: "test",
  DEV: false,
  PROD: false,
};

// Use Node's timers implementation so the returned handles support unref/ref
// requestIdleCallback is used by the renderer for stream batching.
// jsdom doesn't provide it.
globalThis.requestIdleCallback =
  globalThis.requestIdleCallback ??
  ((cb) =>
    globalThis.setTimeout(() =>
      cb({ didTimeout: false, timeRemaining: () => 50 })
    ));
globalThis.cancelIdleCallback =
  globalThis.cancelIdleCallback ?? ((id) => globalThis.clearTimeout(id));

// (required by undici timers). This also provides setImmediate/clearImmediate.
const nodeTimers = require("node:timers");
globalThis.setTimeout = nodeTimers.setTimeout;
globalThis.clearTimeout = nodeTimers.clearTimeout;
globalThis.setInterval = nodeTimers.setInterval;
globalThis.clearInterval = nodeTimers.clearInterval;
globalThis.setImmediate = nodeTimers.setImmediate;
globalThis.clearImmediate = nodeTimers.clearImmediate;

// Polyfill TextEncoder/TextDecoder - required by undici
const { TextEncoder, TextDecoder } = require("util");
globalThis.TextEncoder = globalThis.TextEncoder ?? TextEncoder;
globalThis.TextDecoder = globalThis.TextDecoder ?? TextDecoder;

// Polyfill streams - required by AI SDK
const {
  TransformStream,
  ReadableStream,
  WritableStream,
  TextDecoderStream,
} = require("node:stream/web");
globalThis.TransformStream = globalThis.TransformStream ?? TransformStream;
globalThis.ReadableStream = globalThis.ReadableStream ?? ReadableStream;
globalThis.WritableStream = globalThis.WritableStream ?? WritableStream;
globalThis.TextDecoderStream = globalThis.TextDecoderStream ?? TextDecoderStream;

// Polyfill MessageChannel/MessagePort - required by undici
const { MessageChannel, MessagePort } = require("node:worker_threads");
globalThis.MessageChannel = globalThis.MessageChannel ?? MessageChannel;

// Radix UI (Select, etc.) relies on Pointer Events + pointer capture.
// jsdom doesn't implement these, so provide minimal no-op shims.
if (globalThis.Element && !globalThis.Element.prototype.hasPointerCapture) {
  globalThis.Element.prototype.hasPointerCapture = () => false;
}
if (globalThis.Element && !globalThis.Element.prototype.setPointerCapture) {
  globalThis.Element.prototype.setPointerCapture = () => {};
}
if (globalThis.Element && !globalThis.Element.prototype.scrollIntoView) {
  globalThis.Element.prototype.scrollIntoView = () => {};
}
if (globalThis.Element && !globalThis.Element.prototype.releasePointerCapture) {
  globalThis.Element.prototype.releasePointerCapture = () => {};
}
globalThis.MessagePort = globalThis.MessagePort ?? MessagePort;

// undici reads `performance.markResourceTiming` at import time. In jsdom,
// Some renderer code uses `performance.mark()` for lightweight timing.
if (globalThis.performance && typeof globalThis.performance.mark !== "function") {
  globalThis.performance.mark = () => {};
}
if (globalThis.performance && typeof globalThis.performance.measure !== "function") {
  globalThis.performance.measure = () => {};
}
if (
  globalThis.performance &&
  typeof globalThis.performance.clearMarks !== "function"
) {
  globalThis.performance.clearMarks = () => {};
}
if (
  globalThis.performance &&
  typeof globalThis.performance.clearMeasures !== "function"
) {
  globalThis.performance.clearMeasures = () => {};
}

// `performance` exists but doesn't implement the Resource Timing API.
if (
  globalThis.performance &&
  typeof globalThis.performance.markResourceTiming !== "function"
) {
  globalThis.performance.markResourceTiming = () => {};
}

// Now undici can be safely imported
const { fetch, Request, Response, Headers, FormData, Blob } = require("undici");
globalThis.fetch = globalThis.fetch ?? fetch;
globalThis.Request = globalThis.Request ?? Request;
globalThis.Response = globalThis.Response ?? Response;
globalThis.Headers = globalThis.Headers ?? Headers;
globalThis.FormData = globalThis.FormData ?? FormData;
globalThis.Blob = globalThis.Blob ?? Blob;
