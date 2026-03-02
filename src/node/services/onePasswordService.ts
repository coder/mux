import assert from "node:assert";
import { createClient, DesktopAuth, DesktopSessionExpiredError, type Client } from "@1password/sdk";
import { OP_REF_PREFIX } from "@/common/utils/opRef";
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
    if (this.available === true) {
      return true;
    }

    try {
      await this.getClient();
      this.available = true;
      return true;
    } catch {
      return false;
    }
  }

  async resolve(ref: string): Promise<string | undefined> {
    if (!ref.startsWith(OP_REF_PREFIX)) {
      log.warn("Invalid 1Password reference (not an op:// URI)", { ref });
      return undefined;
    }

    const cached = this.cache.get(ref);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    if (cached) {
      this.cache.delete(ref);
    }

    // Decode percent-encoded segments for backward compatibility —
    // earlier versions of buildReference used encodeURIComponent, but
    // the 1Password SDK only accepts raw characters in op:// references.
    let decodedRef: string;
    try {
      decodedRef = decodeURIComponent(ref);
    } catch {
      decodedRef = ref;
    }

    const resolveWithClient = async (): Promise<string | undefined> => {
      const client = await this.getClient();
      const value = await client.secrets.resolve(decodedRef);
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
      return overviews.map((vault) => ({ id: vault.id, title: vault.title }));
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
      return overviews.map((item) => ({
        id: item.id,
        title: item.title,
        category: String(item.category),
      }));
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
    // The 1Password op:// reference format uses raw characters — spaces
    // are valid, but forward slashes in segment names are an inherent
    // limitation of the scheme (/ is the delimiter). Do NOT
    // encodeURIComponent: the SDK rejects percent-encoded characters.
    const segments = [
      `${OP_REF_PREFIX}${vaultTitle}`,
      itemTitle,
      ...(sectionTitle ? [sectionTitle] : []),
      fieldTitle,
    ];

    return segments.join("/");
  }

  reset(): void {
    this.client = null;
    this.initPromise = null;
    this.available = null;
    this.cache.clear();
  }
}
