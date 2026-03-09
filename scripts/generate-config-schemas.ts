#!/usr/bin/env bun

import * as fs from "node:fs";
import * as path from "node:path";
import { z, type ZodType } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { AppConfigOnDiskSchema } from "../src/common/config/schemas/appConfigOnDisk";
import { ProvidersConfigSchema } from "../src/common/config/schemas/providersConfig";

const outputDir = path.join(import.meta.dir, "..", "src", "common", "config", "json-schema");

const schemas: Array<{ name: string; schema: ZodType }> = [
  { name: "providers", schema: ProvidersConfigSchema },
  { name: "config", schema: AppConfigOnDiskSchema },
];

function isTrivialZodToJsonSchemaOutput(name: string, schema: unknown): boolean {
  if (schema == null || typeof schema !== "object") {
    return true;
  }

  const record = schema as Record<string, unknown>;
  const definitions = record.definitions;
  if (definitions == null || typeof definitions !== "object") {
    return false;
  }

  const namedDefinition = (definitions as Record<string, unknown>)[name];
  if (namedDefinition == null || typeof namedDefinition !== "object") {
    return false;
  }

  return Object.keys(namedDefinition).length === 0;
}

fs.mkdirSync(outputDir, { recursive: true });

for (const { name, schema } of schemas) {
  const schemaFromZodToJsonSchema = zodToJsonSchema(schema, {
    name,
    target: "jsonSchema7",
  });
  const jsonSchema = isTrivialZodToJsonSchemaOutput(name, schemaFromZodToJsonSchema)
    ? z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any" })
    : schemaFromZodToJsonSchema;

  const outPath = path.join(outputDir, `${name}.schema.json`);
  fs.writeFileSync(outPath, JSON.stringify(jsonSchema, null, 2) + "\n", "utf-8");
  console.log(`Generated ${path.relative(process.cwd(), outPath)}`);
}
