import * as path from "path";
import { readdir, readFile, stat } from "fs/promises";
import { log } from "@/node/services/log";

export interface ExtensionManifest {
  entrypoint: string;
}

export type ExtensionType = "file" | "folder";

export interface ExtensionInfo {
  /**
   * Stable identifier for the extension.
   * - file extensions: basename without extension
   * - folder extensions: folder name
   */
  id: string;

  /** Absolute path to the extension entrypoint JS file */
  entryPath: string;

  /** Absolute directory containing the extension (file's parent or folder itself) */
  rootDir: string;

  type: ExtensionType;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const s = await stat(filePath);
    return s.isFile();
  } catch {
    return false;
  }
}

async function readManifest(manifestPath: string): Promise<ExtensionManifest | null> {
  try {
    const raw = await readFile(manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "entrypoint" in parsed &&
      typeof (parsed as { entrypoint?: unknown }).entrypoint === "string"
    ) {
      return { entrypoint: (parsed as { entrypoint: string }).entrypoint };
    }
    return null;
  } catch (error) {
    log.warn("Failed to read extension manifest", { manifestPath, error });
    return null;
  }
}

/**
 * Discover extensions from a single directory.
 *
 * Supported layouts:
 * - ~/.mux/ext/my-ext.js
 * - ~/.mux/ext/my-ext/manifest.json (with { "entrypoint": "index.js" })
 */
export async function discoverExtensions(extDir: string): Promise<ExtensionInfo[]> {
  let entries;
  try {
    entries = await readdir(extDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const extensions: ExtensionInfo[] = [];

  for (const entry of entries) {
    const abs = path.join(extDir, entry.name);

    if (entry.isFile()) {
      if (!entry.name.endsWith(".js") && !entry.name.endsWith(".cjs")) {
        continue;
      }

      const id = entry.name.replace(/\.(cjs|js)$/u, "");
      extensions.push({
        id,
        entryPath: abs,
        rootDir: extDir,
        type: "file",
      });
      continue;
    }

    if (entry.isDirectory()) {
      const manifestPath = path.join(abs, "manifest.json");
      const manifest = await readManifest(manifestPath);
      if (!manifest) continue;

      const entryPath = path.join(abs, manifest.entrypoint);
      if (!(await fileExists(entryPath))) {
        log.warn("Extension manifest entrypoint missing", { entryPath, manifestPath });
        continue;
      }

      extensions.push({
        id: entry.name,
        entryPath,
        rootDir: abs,
        type: "folder",
      });
    }
  }

  extensions.sort((a, b) => a.id.localeCompare(b.id));
  return extensions;
}
