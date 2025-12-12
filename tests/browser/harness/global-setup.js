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
globalThis.import_meta_env = {
  VITE_BACKEND_URL: undefined,
  MODE: "test",
  DEV: false,
  PROD: false,
};

// Patch setTimeout to add unref method (required by undici timers)
// jsdom's setTimeout doesn't have unref, but node's does
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = function patchedSetTimeout(...args) {
  const timer = originalSetTimeout.apply(this, args);
  if (timer && typeof timer === "object" && !timer.unref) {
    timer.unref = () => timer;
    timer.ref = () => timer;
  }
  return timer;
};

const originalSetInterval = globalThis.setInterval;
globalThis.setInterval = function patchedSetInterval(...args) {
  const timer = originalSetInterval.apply(this, args);
  if (timer && typeof timer === "object" && !timer.unref) {
    timer.unref = () => timer;
    timer.ref = () => timer;
  }
  return timer;
};

// Polyfill TextEncoder/TextDecoder - required by undici
const { TextEncoder, TextDecoder } = require("util");
globalThis.TextEncoder = globalThis.TextEncoder ?? TextEncoder;
globalThis.TextDecoder = globalThis.TextDecoder ?? TextDecoder;

// Polyfill streams - required by AI SDK
const { TransformStream, ReadableStream, WritableStream } = require("node:stream/web");
globalThis.TransformStream = globalThis.TransformStream ?? TransformStream;
globalThis.ReadableStream = globalThis.ReadableStream ?? ReadableStream;
globalThis.WritableStream = globalThis.WritableStream ?? WritableStream;

// Polyfill MessageChannel/MessagePort - required by undici
const { MessageChannel, MessagePort } = require("node:worker_threads");
globalThis.MessageChannel = globalThis.MessageChannel ?? MessageChannel;
globalThis.MessagePort = globalThis.MessagePort ?? MessagePort;

// Now undici can be safely imported
const { fetch, Request, Response, Headers, FormData, Blob } = require("undici");
globalThis.fetch = globalThis.fetch ?? fetch;
globalThis.Request = globalThis.Request ?? Request;
globalThis.Response = globalThis.Response ?? Response;
globalThis.Headers = globalThis.Headers ?? Headers;
globalThis.FormData = globalThis.FormData ?? FormData;
globalThis.Blob = globalThis.Blob ?? Blob;
