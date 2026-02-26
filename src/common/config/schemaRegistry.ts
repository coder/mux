import type { z } from "zod";

import { AppConfigOnDiskSchema } from "@/common/config/schemas/appConfigOnDisk";
import { ProvidersConfigSchema } from "@/common/config/schemas/providersConfig";

export type ConfigFileKind = "json" | "jsonc";

export interface ConfigFileEntry<TSchema extends z.ZodTypeAny> {
  fileKind: ConfigFileKind;
  schema: TSchema;
  fileName: string;
}

export const CONFIG_FILE_REGISTRY = {
  providers: {
    fileKind: "jsonc",
    schema: ProvidersConfigSchema,
    fileName: "providers.jsonc",
  },
  config: {
    fileKind: "json",
    schema: AppConfigOnDiskSchema,
    fileName: "config.json",
  },
} as const satisfies Record<string, ConfigFileEntry<z.ZodTypeAny>>;

export type ConfigFileKey = keyof typeof CONFIG_FILE_REGISTRY;

export type ConfigSchemaFor<TKey extends ConfigFileKey> =
  (typeof CONFIG_FILE_REGISTRY)[TKey]["schema"];

export type ConfigDocumentFor<TKey extends ConfigFileKey> = z.infer<ConfigSchemaFor<TKey>>;
