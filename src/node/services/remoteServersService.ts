import assert from "@/common/utils/assert";
import type { RemoteMuxServerConfig } from "@/common/types/project";
import { secretsToRecord, type Secret, type SecretsConfig } from "@/common/types/secrets";
import type { Config } from "@/node/config";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";

const REMOTE_MUX_SERVER_SECRETS_PREFIX = "__remoteMuxServer:";
const REMOTE_MUX_SERVER_AUTH_TOKEN_KEY = "authToken";
const REMOTE_MUX_SERVER_ID_RE = /^[a-zA-Z0-9._-]+$/;

function normalizeRemoteMuxServerId(value: string): string {
  assert(typeof value === "string", "remote server id must be a string");
  const id = value.trim();
  assert(id.length > 0, "remote server id must not be empty");
  assert(
    REMOTE_MUX_SERVER_ID_RE.test(id),
    "remote server id must be filesystem-safe (letters, numbers, ., _, -)"
  );
  return id;
}

function normalizeRemoteMuxServerBaseUrl(value: string): string {
  assert(typeof value === "string", "baseUrl must be a string");
  const trimmed = value.trim();
  assert(trimmed.length > 0, "baseUrl must not be empty");

  const normalized = stripTrailingSlashes(trimmed);
  assert(normalized.length > 0, "baseUrl must not be empty");

  // Defensive: validate baseUrl is an absolute URL. This avoids later surprises when fetching.
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`Invalid baseUrl: ${value}`);
  }

  assert(
    url.protocol === "http:" || url.protocol === "https:",
    "baseUrl must start with http:// or https://"
  );

  return normalized;
}

function normalizeRemoteMuxServerConfig(config: RemoteMuxServerConfig): RemoteMuxServerConfig {
  assert(config && typeof config === "object", "config is required");

  const id = normalizeRemoteMuxServerId(config.id);

  assert(typeof config.label === "string", "config.label must be a string");
  const label = config.label.trim();
  assert(label.length > 0, "config.label must not be empty");

  const baseUrl = normalizeRemoteMuxServerBaseUrl(config.baseUrl);

  assert(Array.isArray(config.projectMappings), "config.projectMappings must be an array");
  const projectMappings: RemoteMuxServerConfig["projectMappings"] = [];
  for (const mapping of config.projectMappings) {
    if (!mapping || typeof mapping !== "object") continue;

    const { localProjectPath, remoteProjectPath } = mapping as {
      localProjectPath?: unknown;
      remoteProjectPath?: unknown;
    };

    if (typeof localProjectPath !== "string" || typeof remoteProjectPath !== "string") {
      continue;
    }

    const localTrimmed = localProjectPath.trim();
    const remoteTrimmed = remoteProjectPath.trim();

    if (!localTrimmed || !remoteTrimmed) {
      continue;
    }

    projectMappings.push({
      localProjectPath: localTrimmed,
      remoteProjectPath: remoteTrimmed,
    });
  }

  return {
    id,
    label,
    baseUrl,
    enabled: config.enabled === true ? true : config.enabled === false ? false : undefined,
    projectMappings,
  };
}

function getRemoteMuxServerSecretsKey(serverId: string): string {
  return `${REMOTE_MUX_SERVER_SECRETS_PREFIX}${serverId}`;
}

function getAuthTokenFromSecrets(secrets: Secret[] | undefined): string | null {
  if (!secrets || secrets.length === 0) {
    return null;
  }

  const record = secretsToRecord(secrets);
  const authToken = record[REMOTE_MUX_SERVER_AUTH_TOKEN_KEY];

  if (typeof authToken !== "string") {
    return null;
  }

  const trimmed = authToken.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed;
}

function hasAuthTokenInSecretsConfig(secretsConfig: SecretsConfig, serverId: string): boolean {
  const secretsKey = getRemoteMuxServerSecretsKey(serverId);
  return Boolean(getAuthTokenFromSecrets(secretsConfig[secretsKey]));
}

export interface RemoteMuxServerListEntry {
  config: RemoteMuxServerConfig;
  hasAuthToken: boolean;
}

export class RemoteServersService {
  constructor(private readonly config: Config) {
    assert(config, "RemoteServersService requires a Config instance");
  }

  list(): RemoteMuxServerListEntry[] {
    const config = this.config.loadConfigOrDefault();
    const remoteServers = config.remoteServers ?? [];

    const secretsConfig = this.config.loadSecretsConfig();

    return remoteServers.map((entry) => ({
      config: entry,
      hasAuthToken: hasAuthTokenInSecretsConfig(secretsConfig, entry.id),
    }));
  }

  getAuthToken(params: { id: string }): string | null {
    const id = normalizeRemoteMuxServerId(params.id);
    const secretsConfig = this.config.loadSecretsConfig();
    const secretsKey = getRemoteMuxServerSecretsKey(id);
    return getAuthTokenFromSecrets(secretsConfig[secretsKey]);
  }

  hasAuthToken(params: { id: string }): boolean {
    return Boolean(this.getAuthToken(params));
  }
  async upsert(params: { config: RemoteMuxServerConfig; authToken?: string }): Promise<void> {
    const normalizedConfig = normalizeRemoteMuxServerConfig(params.config);

    await this.config.editConfig((config) => {
      const existing = config.remoteServers ?? [];
      const next = [...existing];

      const existingIndex = next.findIndex((server) => server.id === normalizedConfig.id);
      if (existingIndex === -1) {
        next.push(normalizedConfig);
      } else {
        next[existingIndex] = normalizedConfig;
      }

      config.remoteServers = next.length > 0 ? next : undefined;
      return config;
    });

    if (params.authToken !== undefined) {
      const trimmed = params.authToken.trim();
      if (trimmed) {
        await this.setAuthToken({ id: normalizedConfig.id, authToken: trimmed });
      } else {
        await this.clearAuthToken({ id: normalizedConfig.id });
      }
    }
  }

  async remove(params: { id: string }): Promise<void> {
    const id = normalizeRemoteMuxServerId(params.id);

    await this.config.editConfig((config) => {
      const existing = config.remoteServers ?? [];
      const next = existing.filter((server) => server.id !== id);
      config.remoteServers = next.length > 0 ? next : undefined;
      return config;
    });

    await this.clearAuthToken({ id });
  }

  async clearAuthToken(params: { id: string }): Promise<void> {
    const id = normalizeRemoteMuxServerId(params.id);
    const secretsKey = getRemoteMuxServerSecretsKey(id);

    const secretsConfig = this.config.loadSecretsConfig();
    const existing = secretsConfig[secretsKey];
    if (!existing) {
      return;
    }

    const next = existing.filter((secret) => secret.key !== REMOTE_MUX_SERVER_AUTH_TOKEN_KEY);

    if (next.length > 0) {
      secretsConfig[secretsKey] = next;
    } else {
      delete secretsConfig[secretsKey];
    }

    await this.config.saveSecretsConfig(secretsConfig);
  }

  async setAuthToken(params: { id: string; authToken: string }): Promise<void> {
    const id = normalizeRemoteMuxServerId(params.id);

    assert(typeof params.authToken === "string", "authToken must be a string");
    const trimmed = params.authToken.trim();
    assert(trimmed.length > 0, "authToken must not be empty");

    const secretsKey = getRemoteMuxServerSecretsKey(id);

    const secretsConfig = this.config.loadSecretsConfig();
    const existing = secretsConfig[secretsKey] ?? [];

    const next = existing.filter((secret) => secret.key !== REMOTE_MUX_SERVER_AUTH_TOKEN_KEY);
    next.push({ key: REMOTE_MUX_SERVER_AUTH_TOKEN_KEY, value: trimmed });

    secretsConfig[secretsKey] = next;
    await this.config.saveSecretsConfig(secretsConfig);
  }

  async ping(params: { id: string }): Promise<unknown> {
    const id = normalizeRemoteMuxServerId(params.id);

    const config = this.config.loadConfigOrDefault();
    const remoteServers = config.remoteServers ?? [];
    const server = remoteServers.find((entry) => entry.id === id);
    if (!server) {
      throw new Error(`Remote server not found: ${id}`);
    }

    const url = `${normalizeRemoteMuxServerBaseUrl(server.baseUrl)}/version`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
      },
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      let body = "";
      try {
        body = await response.text();
      } catch {
        // Ignore
      }

      const prefix = body.trim().slice(0, 200);
      throw new Error(`Remote /version request failed (HTTP ${response.status}): ${prefix}`);
    }

    return response.json() as unknown;
  }
}
