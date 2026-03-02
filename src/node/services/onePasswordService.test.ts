import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Client } from "@1password/sdk";
import { log } from "@/node/services/log";

const mockCreateClient = mock(() => Promise.resolve({} as Client));
const mockLogWarn = mock(() => undefined);

class MockDesktopAuth {
  constructor(public readonly account: string) {}
}

class MockDesktopSessionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopSessionExpiredError";
  }
}

void mock.module("@1password/sdk", () => ({
  createClient: mockCreateClient,
  DesktopAuth: MockDesktopAuth,
  DesktopSessionExpiredError: MockDesktopSessionExpiredError,
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
      list: mock(() => Promise.resolve([] as MockVaultOverview[])),
    },
    items: {
      list: mock(() => Promise.resolve([] as MockItemOverview[])),
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

describe("OnePasswordService", () => {
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mockClient = createMockClient();
    mockCreateClient.mockClear();
    mockLogWarn.mockClear();
    spyOn(log, "warn").mockImplementation(mockLogWarn);

    mockCreateClient.mockImplementation(() => Promise.resolve(mockClient as unknown as Client));
  });

  afterEach(() => {
    mock.restore();
  });

  it("isAvailable() returns false when createClient rejects", async () => {
    mockCreateClient.mockImplementationOnce(() => Promise.reject(new Error("create failed")));

    const service = new OnePasswordService("account-a");

    expect(await service.isAvailable()).toBe(false);
  });

  it("isAvailable() retries after initial createClient failure", async () => {
    mockCreateClient
      .mockImplementationOnce(() => Promise.reject(new Error("create failed")))
      .mockImplementationOnce(() => Promise.resolve(mockClient as unknown as Client));

    const service = new OnePasswordService("account-a");

    expect(await service.isAvailable()).toBe(false);
    expect(await service.isAvailable()).toBe(true);
    expect(mockCreateClient).toHaveBeenCalledTimes(2);
  });

  it("isAvailable() returns true when createClient resolves", async () => {
    const service = new OnePasswordService("account-a");

    expect(await service.isAvailable()).toBe(true);
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

    expect(await service.resolve(ref)).toBe("secret-value");
  });

  it("resolve() decodes percent-encoded references before SDK resolution", async () => {
    const service = new OnePasswordService("account-a");
    const encodedRef = "op://Vault/OpenAI%20Key/password";

    mockClient.secrets.resolve.mockImplementationOnce((ref: string) =>
      Promise.resolve(`decoded:${ref}`)
    );

    expect(await service.resolve(encodedRef)).toBe("decoded:op://Vault/OpenAI Key/password");
    expect(mockClient.secrets.resolve).toHaveBeenCalledWith("op://Vault/OpenAI Key/password");
  });

  it("resolve() returns undefined when client creation fails", async () => {
    const service = new OnePasswordService("account-a");

    mockCreateClient.mockImplementationOnce(() => Promise.reject(new Error("create failed")));

    expect(await service.resolve("op://vault/item/password")).toBeUndefined();
  });

  it("resolve() returns undefined on SDK resolve error", async () => {
    const service = new OnePasswordService("account-a");

    mockClient.secrets.resolve.mockImplementationOnce(() =>
      Promise.reject(new Error("resolve failed"))
    );

    expect(await service.resolve("op://vault/item/password")).toBeUndefined();
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

  it("resolve() returns undefined on non-op:// input", async () => {
    const service = new OnePasswordService("account-a");

    expect(await service.resolve("not-a-reference")).toBeUndefined();
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

    // Flush microtasks so both requests race through the shared initPromise path.
    for (let i = 0; i < 10 && mockCreateClient.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }

    expect(mockCreateClient).toHaveBeenCalledTimes(1);

    deferred.resolve(concurrentClient as unknown as Client);

    expect(await firstPromise).toBe("value:op://vault/item/field-a");
    expect(await secondPromise).toBe("value:op://vault/item/field-b");
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
  });

  it("reset() clears all state", async () => {
    const service = new OnePasswordService("account-a");
    const ref = "op://vault/item/password";

    mockClient.secrets.resolve
      .mockImplementationOnce(() => Promise.resolve("before-reset"))
      .mockImplementationOnce(() => Promise.resolve("after-reset"));

    expect(await service.resolve(ref)).toBe("before-reset");
    expect(await service.isAvailable()).toBe(true);

    service.reset();

    expect(await service.isAvailable()).toBe(true);
    expect(await service.resolve(ref)).toBe("after-reset");
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

    expect(await service.resolve("op://vault/item/password")).toBe("refreshed-secret");

    expect(mockCreateClient).toHaveBeenCalledTimes(2);
    expect(firstClient.secrets.resolve).toHaveBeenCalledTimes(1);
    expect(secondClient.secrets.resolve).toHaveBeenCalledTimes(1);
  });

  it("listVaults() returns mapped vault data", async () => {
    const service = new OnePasswordService("account-a");

    mockClient.vaults.list.mockImplementationOnce(() =>
      Promise.resolve([
        { id: "v1", title: "Engineering" },
        { id: "v2", title: "Personal" },
      ])
    );

    expect(await service.listVaults()).toEqual([
      { id: "v1", title: "Engineering" },
      { id: "v2", title: "Personal" },
    ]);
  });

  it("listVaults() retries once on DesktopSessionExpiredError", async () => {
    const service = new OnePasswordService("account-a");
    const firstClient = createMockClient();
    const secondClient = createMockClient();

    firstClient.vaults.list.mockImplementationOnce(() => {
      return Promise.reject(new MockDesktopSessionExpiredError("expired"));
    });
    secondClient.vaults.list.mockImplementationOnce(() =>
      Promise.resolve([{ id: "v1", title: "Engineering" }])
    );

    mockCreateClient
      .mockImplementationOnce(() => Promise.resolve(firstClient as unknown as Client))
      .mockImplementationOnce(() => Promise.resolve(secondClient as unknown as Client));

    expect(await service.listVaults()).toEqual([{ id: "v1", title: "Engineering" }]);

    expect(mockCreateClient).toHaveBeenCalledTimes(2);
    expect(firstClient.vaults.list).toHaveBeenCalledTimes(1);
    expect(secondClient.vaults.list).toHaveBeenCalledTimes(1);
  });

  it("listItems() returns mapped item data", async () => {
    const service = new OnePasswordService("account-a");

    mockClient.items.list.mockImplementationOnce(() =>
      Promise.resolve([
        { id: "i1", title: "Github", category: "LOGIN" },
        { id: "i2", title: "AWS", category: "API_CREDENTIAL" },
      ])
    );

    expect(await service.listItems("vault-a")).toEqual([
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

    expect(await service.getItemFields("vault-a", "item-a")).toEqual([
      { id: "f1", title: "username", sectionTitle: "Login", sectionId: "s1" },
      { id: "f2", title: "password", sectionTitle: "Login", sectionId: "s1" },
      { id: "f3", title: "token", sectionTitle: undefined, sectionId: "s2" },
      { id: "f4", title: "notes", sectionTitle: undefined, sectionId: undefined },
    ]);
  });

  it("buildReference() constructs op://vault/item/field from IDs", () => {
    expect(OnePasswordService.buildReference("vault-uuid", "item-uuid", "field-uuid")).toBe(
      "op://vault-uuid/item-uuid/field-uuid"
    );
  });

  it("buildReference() keeps spaces as raw characters", () => {
    expect(OnePasswordService.buildReference("Mux", "OpenAI mux gateway voice", "password")).toBe(
      "op://Mux/OpenAI mux gateway voice/password"
    );
  });

  it("buildReference() includes section ID when provided", () => {
    expect(
      OnePasswordService.buildReference("vault-uuid", "item-uuid", "field-uuid", "section-uuid")
    ).toBe("op://vault-uuid/item-uuid/section-uuid/field-uuid");
  });

  it("buildReference() keeps forward slashes raw within segment titles", () => {
    expect(
      OnePasswordService.buildReference("Vault/Prod", "Item/Main", "pass/word", "Login/Primary")
    ).toBe("op://Vault/Prod/Item/Main/Login/Primary/pass/word");
  });

  it("buildLabel() joins vault, item, and field titles with separators", () => {
    expect(OnePasswordService.buildLabel("Mux", "OpenAI Key", "password")).toBe(
      "Mux / OpenAI Key / password"
    );
  });

  it("buildLabel() includes section title when provided", () => {
    expect(OnePasswordService.buildLabel("Mux", "OpenAI Key", "password", "Credentials")).toBe(
      "Mux / OpenAI Key / Credentials / password"
    );
  });

  it("buildLabel() treats empty section title as absent", () => {
    expect(OnePasswordService.buildLabel("Mux", "OpenAI Key", "password", "")).toBe(
      "Mux / OpenAI Key / password"
    );
  });
});
