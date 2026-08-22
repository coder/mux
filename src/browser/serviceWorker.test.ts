import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

interface WorkerEvent {
  waitUntil(promise: Promise<unknown>): void;
}

test("activation removes the pre-rename cache without deleting the current cache", async () => {
  const listeners = new Map<string, (event: WorkerEvent) => void>();
  const deletedCaches: string[] = [];
  let activation: Promise<unknown> | undefined;

  const self = {
    addEventListener: (name: string, listener: (event: WorkerEvent) => void) => {
      listeners.set(name, listener);
    },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
  };
  const caches = {
    keys: () => Promise.resolve(["xum-v3", "mux-v2"]),
    delete: (name: string) => {
      deletedCaches.push(name);
      return Promise.resolve(true);
    },
  };

  const source = readFileSync(new URL("../../public/service-worker.js", import.meta.url), "utf8");
  runInNewContext(source, { self, caches });

  const activate = listeners.get("activate");
  expect(activate).toBeDefined();
  activate?.({
    waitUntil: (promise) => {
      activation = promise;
    },
  });
  await activation;

  expect(deletedCaches).toEqual(["mux-v2"]);
});
