import { z } from "zod";

import { ExtensionNameSchema } from "@/common/orpc/schemas/extension";

export const EXTENSION_SOURCE_LOCK_SCHEMA_VERSION = 1 as const;

const WINDOWS_ABSOLUTE_PATH_REGEX = /^[A-Za-z]:[/\\]/;
const ContentHashSchema = z.string().regex(/^sha256:[a-zA-Z0-9+/=_-]{32,}$/);
const GitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const RelativeSourceSubdirSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"), { message: "must not contain null bytes" })
  .refine((value) => !WINDOWS_ABSOLUTE_PATH_REGEX.test(value), {
    message: "must be a relative path",
  })
  .refine((value) => !value.startsWith("/") && !value.startsWith("\\"), {
    message: "must be a relative path",
  })
  .refine((value) => !value.split(/[\\/]/).includes(".."), {
    message: "must not contain .. segments",
  });

export const GitExtensionSourceLockSchema = z
  .object({
    type: z.literal("git"),
    url: z.string().min(1),
    ref: z.string().min(1),
    resolvedSha: GitShaSchema,
    subdir: RelativeSourceSubdirSchema.nullish(),
    contentHash: ContentHashSchema,
  })
  .strict();

export const VendoredExtensionSourceLockSchema = z
  .object({
    type: z.literal("vendored"),
    path: RelativeSourceSubdirSchema,
    contentHash: ContentHashSchema,
  })
  .strict();

export const GlobalExtensionSourceLockEntrySchema = z
  .object({
    source: GitExtensionSourceLockSchema,
  })
  .strict();

export const ProjectExtensionSourceLockEntrySchema = z
  .object({
    source: z.discriminatedUnion("type", [
      GitExtensionSourceLockSchema,
      VendoredExtensionSourceLockSchema,
    ]),
  })
  .strict();

export const GlobalExtensionSourceLockSchema = z
  .object({
    schemaVersion: z.literal(EXTENSION_SOURCE_LOCK_SCHEMA_VERSION),
    extensions: z.record(ExtensionNameSchema, GlobalExtensionSourceLockEntrySchema),
  })
  .strict();

export const ProjectExtensionSourceLockSchema = z
  .object({
    schemaVersion: z.literal(EXTENSION_SOURCE_LOCK_SCHEMA_VERSION),
    extensions: z.record(ExtensionNameSchema, ProjectExtensionSourceLockEntrySchema),
  })
  .strict();

export type GitExtensionSourceLock = z.infer<typeof GitExtensionSourceLockSchema>;
export type VendoredExtensionSourceLock = z.infer<typeof VendoredExtensionSourceLockSchema>;
export type GlobalExtensionSourceLockEntry = z.infer<typeof GlobalExtensionSourceLockEntrySchema>;
export type ProjectExtensionSourceLockEntry = z.infer<typeof ProjectExtensionSourceLockEntrySchema>;
export type GlobalExtensionSourceLock = z.infer<typeof GlobalExtensionSourceLockSchema>;
export type ProjectExtensionSourceLock = z.infer<typeof ProjectExtensionSourceLockSchema>;
