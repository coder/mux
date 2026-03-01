import assert from "node:assert";
import { createClient, DesktopAuth, DesktopSessionExpiredError, type Client } from "@1password/sdk";
import { OP_REF_PREFIX, isOpReference } from "@/common/utils/opRef";
import { log } from "@/node/services/log";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const INTEGRATION_NAME = "Mux Desktop";
const INTEGRATION_VERSION = "1.0.0";

interface CacheEntry {
  value: string;
  expiresAt: number;
}

export class OnePasswordService {
  private readonly accountName: string;
  private client: Client | null = null;
  private initPromise: Promise<Client> | null = null;
  private available: boolean | null = null;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(accountName: string) {
    assert(accountName.trim().length > 0, "OnePasswordService accountName must be non-empty");
    this.accountName = accountName;
  }

  private async getClient(): Promise<Client> {
    if (this.client) {
      return this.client;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    const initPromise = createClient({
      auth: new DesktopAuth(this.accountName),
      integrationName: INTEGRATION_NAME,
      integrationVersion: INTEGRATION_VERSION,
    })
      .then((client) => {
        this.client = client;
        return client;
      })
      .finally(() => {
        this.initPromise = null;
      });

    this.initPromise = initPromise;
    return initPromise;
  }

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) {
      return this.available;
    }

    try {
      await this.getClient();
      this.available = true;
    } catch {
      this.available = false;
    }

    return this.available;
  }

  async resolve(ref: string): Promise<string | undefined> {
    assert(
      isOpReference(ref),
      `OnePasswordService.resolve expects a valid ${OP_REF_PREFIX} reference`
    );

    const cached = this.cache.get(ref);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    if (cached) {
      this.cache.delete(ref);
    }

    const resolveWithClient = async (): Promise<string | undefined> => {
      const client = await this.getClient();
      const value = await client.secrets.resolve(ref);
      if (typeof value !== "string") {
        log.warn("[OnePasswordService] Resolved secret was not a string", {
          ref,
          type: typeof value,
        });
        return undefined;
      }

      this.cache.set(ref, {
        value,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      return value;
    };

    try {
      return await resolveWithClient();
    } catch (error) {
      if (error instanceof DesktopSessionExpiredError) {
        this.client = null;
        this.initPromise = null;

        try {
          return await resolveWithClient();
        } catch (retryError) {
          log.warn("[OnePasswordService] Failed to resolve secret after session refresh", {
            ref,
            error: retryError,
          });
          return undefined;
        }
      }

      log.warn("[OnePasswordService] Failed to resolve secret", { ref, error });
      return undefined;
    }
  }

  async listVaults(): Promise<Array<{ id: string; title: string }>> {
    try {
      const client = await this.getClient();
      const overviews = await client.vaults.list();
      const vaults: Array<{ id: string; title: string }> = [];

      for await (const vault of overviews) {
        vaults.push({ id: vault.id, title: vault.title });
      }

      return vaults;
    } catch (error) {
      log.warn("[OnePasswordService] Failed to list vaults", { error });
      return [];
    }
  }

  async listItems(
    vaultId: string
  ): Promise<Array<{ id: string; title: string; category: string }>> {
    try {
      const client = await this.getClient();
      const overviews = await client.items.list(vaultId);
      const items: Array<{ id: string; title: string; category: string }> = [];

      for await (const item of overviews) {
        items.push({
          id: item.id,
          title: item.title,
          category: String(item.category),
        });
      }

      return items;
    } catch (error) {
      log.warn("[OnePasswordService] Failed to list items", { error, vaultId });
      return [];
    }
  }

  async getItemFields(
    vaultId: string,
    itemId: string
  ): Promise<Array<{ id: string; title: string; sectionTitle?: string }>> {
    try {
      const client = await this.getClient();
      const item = await client.items.get(vaultId, itemId);
      const sectionTitles = new Map<string, string>();
      for (const section of item.sections) {
        sectionTitles.set(section.id, section.title);
      }

      return item.fields.map((field) => ({
        id: field.id,
        title: field.title,
        sectionTitle: field.sectionId ? sectionTitles.get(field.sectionId) : undefined,
      }));
    } catch (error) {
      log.warn("[OnePasswordService] Failed to list item fields", { error, vaultId, itemId });
      return [];
    }
  }

  static buildReference(
    vaultTitle: string,
    itemTitle: string,
    fieldTitle: string,
    sectionTitle?: string
  ): string {
    return `${OP_REF_PREFIX}${vaultTitle}/${itemTitle}/${
      sectionTitle ? `${sectionTitle}/` : ""
    }${fieldTitle}`;
  }

  reset(): void {
    this.client = null;
    this.initPromise = null;
    this.available = null;
    this.cache.clear();
  }
}
