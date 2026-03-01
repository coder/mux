import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Client } from "@1password/sdk";

const mockCreateClient = mock(() => Promise.resolve({} as Client));
const mockLogWarn = mock(() => undefined);

class MockDesktopAuth {
  constructor(public readonly account: string) {}
}

class MockDesktopSessionExpiredError extends Error {}

void mock.module("@1password/sdk", () => ({
  createClient: mockCreateClient,
  DesktopAuth: MockDesktopAuth,
  DesktopSessionExpiredError: MockDesktopSessionExpiredError,
}));

void mock.module("@/node/services/log", () => ({
  log: {
    warn: mockLogWarn,
  },
}));

import { OnePasswordService } from "./onePasswordService";

interface MockVaultOverview {
  id: string;
  title: string;
}

interface MockItemOverview {
  id: string;
  title: string;
  category: string;
}

interface MockItem {
  fields: Array<{
    id: string;
    title: string;
    sectionId?: string;
  }>;
  sections: Array<{
    id: string;
    title: string;
  }>;
}

function createMockClient() {
  return {
    secrets: {
      resolve: mock((ref: string) => Promise.resolve(`secret:${ref}`)),
    },
    vaults: {
      list: mock(() => Promise.resolve(asyncIterable<MockVaultOverview>([]))),
    },
    items: {
      list: mock(() => Promise.resolve(asyncIterable<MockItemOverview>([]))),
      get: mock(() => Promise.resolve({ fields: [], sections: [] } as MockItem)),
    },
  };
}

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function* asyncIterable<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

describe("OnePasswordService", () => {
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mockClient = createMockClient();
    mockCreateClient.mockClear();
    mockLogWarn.mockClear();

    mockCreateClient.mockImplementation(() => Promise.resolve(mockClient as unknown as Client));
  });

  afterEach(() => {
    mock.restore();
  });

  it("isAvailable() returns false when createClient rejects", async () => {
    mockCreateClient.mockImplementationOnce(() => Promise.reject(new Error("create failed")));

    const service = new OnePasswordService("account-a");

    await expect(service.isAvailable()).resolves.toBe(false);
  });

  it("isAvailable() returns true when createClient resolves", async () => {
    const service = new OnePasswordService("account-a");

    await expect(service.isAvailable()).resolves.toBe(true);
  });

  it("isAvailable() caches result", async () => {
    const service = new OnePasswordService("account-a");

    await service.isAvailable();
    await service.isAvailable();

    expect(mockCreateClient).toHaveBeenCalledTimes(1);
  });

  it("resolve() returns secret value for valid op:// ref", async () => {
    const service = new OnePasswordService("account-a");
    const ref = "op://vault/item/password";

    mockClient.secrets.resolve.mockImplementationOnce(() => Promise.resolve("secret-value"));

    await expect(service.resolve(ref)).resolves.toBe("secret-value");
  });

  it("resolve() returns undefined when client creation fails", async () => {
    const service = new OnePasswordService("account-a");

    mockCreateClient.mockImplementationOnce(() => Promise.reject(new Error("create failed")));

    await expect(service.resolve("op://vault/item/password")).resolves.toBeUndefined();
  });

  it("resolve() returns undefined on SDK resolve error", async () => {
    const service = new OnePasswordService("account-a");

    mockClient.secrets.resolve.mockImplementationOnce(() =>
      Promise.reject(new Error("resolve failed"))
    );

    await expect(service.resolve("op://vault/item/password")).resolves.toBeUndefined();
  });

  it("resolve() uses cache within TTL", async () => {
    const service = new OnePasswordService("account-a");
    const ref = "op://vault/item/password";

    mockClient.secrets.resolve.mockImplementationOnce(() => Promise.resolve("cached-secret"));

    const first = await service.resolve(ref);
    const second = await service.resolve(ref);

    expect(first).toBe("cached-secret");
    expect(second).toBe("cached-secret");
    expect(mockClient.secrets.resolve).toHaveBeenCalledTimes(1);
  });

  it("resolve() re-fetches after TTL expires", async () => {
    const service = new OnePasswordService("account-a");
    const ref = "op://vault/item/password";
    let now = 100;
    const nowSpy = spyOn(Date, "now").mockImplementation(() => now);

    try {
      mockClient.secrets.resolve
        .mockImplementationOnce(() => Promise.resolve("before-ttl"))
        .mockImplementationOnce(() => Promise.resolve("after-ttl"));

      const first = await service.resolve(ref);
      now += 5 * 60 * 1000 + 1;
      const second = await service.resolve(ref);

      expect(first).toBe("before-ttl");
      expect(second).toBe("after-ttl");
      expect(mockClient.secrets.resolve).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("resolve() asserts on non-op:// input", async () => {
    const service = new OnePasswordService("account-a");

    await expect(service.resolve("not-a-reference")).rejects.toThrow("op://");
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent getClient() calls", async () => {
    const service = new OnePasswordService("account-a");
    const deferred = createDeferred<Client>();
    const concurrentClient = createMockClient();

    concurrentClient.secrets.resolve.mockImplementation((ref: string) =>
      Promise.resolve(`value:${ref}`)
    );
    mockCreateClient.mockImplementationOnce(() => deferred.promise);

    const firstPromise = service.resolve("op://vault/item/field-a");
    const secondPromise = service.resolve("op://vault/item/field-b");

    expect(mockCreateClient).toHaveBeenCalledTimes(1);

    deferred.resolve(concurrentClient as unknown as Client);

    await expect(firstPromise).resolves.toBe("value:op://vault/item/field-a");
    await expect(secondPromise).resolves.toBe("value:op://vault/item/field-b");
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
  });

  it("reset() clears all state", async () => {
    const service = new OnePasswordService("account-a");
    const ref = "op://vault/item/password";

    mockClient.secrets.resolve
      .mockImplementationOnce(() => Promise.resolve("before-reset"))
      .mockImplementationOnce(() => Promise.resolve("after-reset"));

    await expect(service.resolve(ref)).resolves.toBe("before-reset");
    await expect(service.isAvailable()).resolves.toBe(true);

    service.reset();

    await expect(service.isAvailable()).resolves.toBe(true);
    await expect(service.resolve(ref)).resolves.toBe("after-reset");
    expect(mockCreateClient).toHaveBeenCalledTimes(2);
    expect(mockClient.secrets.resolve).toHaveBeenCalledTimes(2);
  });

  it("resolve() retries once on DesktopSessionExpiredError", async () => {
    const service = new OnePasswordService("account-a");
    const firstClient = createMockClient();
    const secondClient = createMockClient();

    firstClient.secrets.resolve.mockImplementationOnce(() => {
      return Promise.reject(new MockDesktopSessionExpiredError("expired"));
    });
    secondClient.secrets.resolve.mockImplementationOnce(() => Promise.resolve("refreshed-secret"));

    mockCreateClient
      .mockImplementationOnce(() => Promise.resolve(firstClient as unknown as Client))
      .mockImplementationOnce(() => Promise.resolve(secondClient as unknown as Client));

    await expect(service.resolve("op://vault/item/password")).resolves.toBe("refreshed-secret");

    expect(mockCreateClient).toHaveBeenCalledTimes(2);
    expect(firstClient.secrets.resolve).toHaveBeenCalledTimes(1);
    expect(secondClient.secrets.resolve).toHaveBeenCalledTimes(1);
  });

  it("listVaults() returns mapped vault data", async () => {
    const service = new OnePasswordService("account-a");

    mockClient.vaults.list.mockImplementationOnce(() =>
      Promise.resolve(
        asyncIterable([
          { id: "v1", title: "Engineering" },
          { id: "v2", title: "Personal" },
        ])
      )
    );

    await expect(service.listVaults()).resolves.toEqual([
      { id: "v1", title: "Engineering" },
      { id: "v2", title: "Personal" },
    ]);
  });

  it("listItems() returns mapped item data", async () => {
    const service = new OnePasswordService("account-a");

    mockClient.items.list.mockImplementationOnce(() =>
      Promise.resolve(
        asyncIterable([
          { id: "i1", title: "Github", category: "LOGIN" },
          { id: "i2", title: "AWS", category: "API_CREDENTIAL" },
        ])
      )
    );

    await expect(service.listItems("vault-a")).resolves.toEqual([
      { id: "i1", title: "Github", category: "LOGIN" },
      { id: "i2", title: "AWS", category: "API_CREDENTIAL" },
    ]);
  });

  it("getItemFields() returns fields with section titles", async () => {
    const service = new OnePasswordService("account-a");

    mockClient.items.get.mockImplementationOnce(() =>
      Promise.resolve({
        fields: [
          { id: "f1", title: "username", sectionId: "s1" },
          { id: "f2", title: "password", sectionId: "s1" },
          { id: "f3", title: "token", sectionId: "s2" },
          { id: "f4", title: "notes" },
        ],
        sections: [{ id: "s1", title: "Login" }],
      })
    );

    await expect(service.getItemFields("vault-a", "item-a")).resolves.toEqual([
      { id: "f1", title: "username", sectionTitle: "Login" },
      { id: "f2", title: "password", sectionTitle: "Login" },
      { id: "f3", title: "token", sectionTitle: undefined },
      { id: "f4", title: "notes", sectionTitle: undefined },
    ]);
  });

  it("buildReference() constructs op://vault/item/field", () => {
    expect(OnePasswordService.buildReference("Vault", "Item", "password")).toBe(
      "op://Vault/Item/password"
    );
  });

  it("buildReference() includes section when provided", () => {
    expect(OnePasswordService.buildReference("Vault", "Item", "password", "Login")).toBe(
      "op://Vault/Item/Login/password"
    );
  });
});
