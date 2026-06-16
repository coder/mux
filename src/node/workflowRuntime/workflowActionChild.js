const { createRequire } = require("node:module");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

const STDIO_LIMIT_BYTES = 64 * 1024;
const RESULT_LIMIT_BYTES = 1024 * 1024;
const MAX_ARTIFACT_COUNT = 32;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

function schemaWithOptions(schema, options) {
  if (options && typeof options === "object" && !Array.isArray(options)) {
    return Object.assign(schema, options);
  }
  return schema;
}
function schemaString(options) {
  return schemaWithOptions({ type: "string" }, options);
}
function schemaNumber(options) {
  return schemaWithOptions({ type: "number" }, options);
}
function schemaInteger(options) {
  return schemaWithOptions({ type: "integer" }, options);
}
function schemaBoolean(options) {
  return schemaWithOptions({ type: "boolean" }, options);
}
function schemaArray(items, options) {
  return schemaWithOptions({ type: "array", items }, options);
}
function schemaEnum(values, options) {
  return schemaWithOptions({ type: "string", enum: Array.isArray(values) ? values : [] }, options);
}
function schemaOptional(schema) {
  const clone = Object.assign({}, schema || {});
  Object.defineProperty(clone, "__muxOptional", { value: true });
  return clone;
}
function schemaIsOptional(schema) {
  return Boolean(schema && schema.__muxOptional === true);
}
function schemaStripOptional(schema) {
  return schemaIsOptional(schema) ? Object.assign({}, schema) : schema;
}
function schemaNullable(schema) {
  const clone = Object.assign({}, schema || {});
  if (typeof clone.type === "string")
    clone.type = clone.type === "null" ? ["null"] : [clone.type, "null"];
  else if (Array.isArray(clone.type))
    clone.type = clone.type.includes("null") ? clone.type : [...clone.type, "null"];
  else clone.type = ["null"];
  if (Array.isArray(clone.enum) && !clone.enum.includes(null)) {
    clone.enum = [...clone.enum, null];
  }
  return clone;
}
function schemaUnion(schemas) {
  const types = [];
  for (const schema of Array.isArray(schemas) ? schemas : []) {
    const schemaTypes = Array.isArray(schema && schema.type)
      ? schema.type
      : [schema && schema.type];
    for (const type of schemaTypes) {
      if (typeof type === "string" && !types.includes(type)) types.push(type);
    }
  }
  return { type: types };
}
function schemaObject(properties, options) {
  const sourceProperties = properties || {};
  const cleanProperties = {};
  const inferredRequired = [];
  for (const key of Object.keys(sourceProperties)) {
    const propertySchema = sourceProperties[key];
    cleanProperties[key] = schemaStripOptional(propertySchema);
    if (!schemaIsOptional(propertySchema)) inferredRequired.push(key);
  }
  let required = inferredRequired;
  if (options && Array.isArray(options.required)) {
    required = options.required.filter((key) =>
      Object.prototype.hasOwnProperty.call(cleanProperties, key)
    );
  } else if (options && options.required === false) {
    required = [];
  }
  const schema = { type: "object", required, properties: cleanProperties };
  if (options && Object.prototype.hasOwnProperty.call(options, "additionalProperties")) {
    schema.additionalProperties = options.additionalProperties;
  }
  return schema;
}

globalThis.mux = Object.freeze({
  schema: Object.freeze({
    string: schemaString,
    number: schemaNumber,
    integer: schemaInteger,
    boolean: schemaBoolean,
    array: schemaArray,
    object: schemaObject,
    enum: schemaEnum,
    union: schemaUnion,
    optional: schemaOptional,
    nullable: schemaNullable,
  }),
});

function createCapture() {
  return { text: "", bytes: 0, truncated: false };
}

function appendCapture(capture, chunk) {
  if (capture.bytes >= STDIO_LIMIT_BYTES) {
    capture.truncated = true;
    return;
  }
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const remaining = STDIO_LIMIT_BYTES - capture.bytes;
  const accepted = buffer.byteLength <= remaining ? buffer : buffer.subarray(0, remaining);
  capture.text += accepted.toString();
  capture.bytes += accepted.byteLength;
  if (accepted.byteLength < buffer.byteLength) capture.truncated = true;
}

function finishCapture(capture) {
  return capture.truncated
    ? capture.text + "\n[truncated after " + STDIO_LIMIT_BYTES + " bytes]"
    : capture.text;
}

function captureResult(capture) {
  return { text: finishCapture(capture), truncated: capture.truncated };
}

function listChildPids(pid) {
  try {
    return execFileSync("ps", ["-axo", "pid=,ppid="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split(/\n+/)
      .map((line) =>
        line
          .trim()
          .split(/\s+/)
          .map((value) => Number(value))
      )
      .filter(([childPid, parentPid]) => Number.isFinite(childPid) && parentPid === pid)
      .map(([childPid]) => childPid);
  } catch {
    return [];
  }
}

function collectDescendantPids(pid, seen = new Set()) {
  const descendants = [];
  for (const childPid of listChildPids(pid)) {
    if (seen.has(childPid)) continue;
    seen.add(childPid);
    descendants.push(...collectDescendantPids(childPid, seen), childPid);
  }
  return descendants;
}

function killPid(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

function killProcessTree(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {}
    return;
  }
  for (const descendantPid of collectDescendantPids(pid)) {
    killPid(descendantPid);
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    killPid(pid);
  }
}

const activeExecPids = new Set();

function writeExecPidFile(execPidPath) {
  if (typeof execPidPath !== "string" || execPidPath.length === 0) return;
  try {
    fsSync.writeFileSync(execPidPath, JSON.stringify(Array.from(activeExecPids)), "utf-8");
  } catch {}
}

function trackExecPid(execPidPath, pid) {
  if (!Number.isFinite(pid) || pid <= 0) return;
  activeExecPids.add(pid);
  writeExecPidFile(execPidPath);
}

function untrackExecPid(execPidPath, pid) {
  activeExecPids.delete(pid);
  writeExecPidFile(execPidPath);
}

function killActiveExecProcesses() {
  for (const pid of Array.from(activeExecPids)) {
    killProcessTree(pid);
  }
}

function handleShutdown() {
  killActiveExecProcesses();
  process.exit(143);
}

process.once("SIGTERM", handleShutdown);
process.once("SIGINT", handleShutdown);

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(input));
  });
}

function normalizeEffect(rawEffect) {
  if (rawEffect === "read" || rawEffect === "readonly" || rawEffect === "read-only") {
    return "read";
  }
  if (rawEffect === "workspace" || rawEffect === "workspace-mutating") {
    return "workspace";
  }
  if (rawEffect === "external" || rawEffect === "external-side-effect") {
    return "external";
  }
  return rawEffect;
}

function normalizeMetadata(rawMetadata) {
  const metadata = rawMetadata && typeof rawMetadata === "object" ? rawMetadata : {};
  return {
    version: metadata.version ?? 1,
    description: metadata.description,
    effect: normalizeEffect(metadata.effect ?? metadata.effectLevel),
    ...(metadata.inputSchema !== undefined ? { inputSchema: metadata.inputSchema } : {}),
    ...(metadata.outputSchema !== undefined ? { outputSchema: metadata.outputSchema } : {}),
    ...(metadata.permissions !== undefined ? { permissions: metadata.permissions } : {}),
    ...(metadata.timeoutMs !== undefined ? { timeoutMs: metadata.timeoutMs } : {}),
  };
}

function maskActionSourceForSyntax(source) {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (current === "/" && next === "/") {
      output += "  ";
      index += 2;
      while (index < source.length && source[index] !== "\n") {
        output += " ";
        index += 1;
      }
      continue;
    }
    if (current === "/" && next === "*") {
      output += "  ";
      index += 2;
      while (index < source.length) {
        const blockCurrent = source[index];
        const blockNext = source[index + 1];
        if (blockCurrent === "*" && blockNext === "/") {
          output += "  ";
          index += 2;
          break;
        }
        output += blockCurrent === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }
    if (current === "/" && isRegExpLiteralStart(output)) {
      const closingIndex = findRegExpLiteralEnd(source, index);
      if (closingIndex !== -1) {
        output += "/";
        index += 1;
        while (index < closingIndex) {
          output += " ";
          index += 1;
        }
        output += "/";
        index += 1;
        continue;
      }
    }
    if (current === '"' || current === "'" || current === "`") {
      const quote = current;
      output += quote;
      index += 1;
      while (index < source.length) {
        const stringCurrent = source[index];
        output += stringCurrent === "\n" ? "\n" : stringCurrent === quote ? quote : " ";
        index += 1;
        if (stringCurrent === "\\") {
          if (index < source.length) {
            output += source[index] === "\n" ? "\n" : " ";
            index += 1;
          }
          continue;
        }
        if (stringCurrent === quote) break;
      }
      continue;
    }
    output += current;
    index += 1;
  }
  return output;
}

function findRegExpLiteralEnd(source, openIndex) {
  let index = openIndex + 1;
  let inCharacterClass = false;
  while (index < source.length) {
    const character = source[index];
    if (character === "\n") return -1;
    if (character === "\\") {
      index += source[index + 1] === "\n" ? 1 : 2;
      continue;
    }
    if (character === "[") inCharacterClass = true;
    else if (character === "]") inCharacterClass = false;
    else if (character === "/" && !inCharacterClass) return index;
    index += 1;
  }
  return -1;
}

const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "throw",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);
const OBJECT_PRECEDING_KEYWORDS = new Set([
  "return",
  "throw",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "yield",
  "await",
]);
const PAREN_STATEMENT_KEYWORDS = new Set(["if", "while", "for", "switch", "with"]);
const IDENTIFIER_CHARACTER = /[A-Za-z0-9_$]/;

function isRegExpLiteralStart(maskedPrefix) {
  let index = maskedPrefix.length - 1;
  while (index >= 0) {
    const character = maskedPrefix[index];
    if (character === " " || character === "\n" || character === "\t" || character === "\r") {
      index -= 1;
      continue;
    }
    break;
  }
  if (index < 0) return true;
  const character = maskedPrefix[index];
  if (IDENTIFIER_CHARACTER.test(character)) {
    let start = index;
    while (start >= 0 && IDENTIFIER_CHARACTER.test(maskedPrefix[start])) start -= 1;
    return REGEX_PRECEDING_KEYWORDS.has(maskedPrefix.slice(start + 1, index + 1));
  }
  if (character === "+" || character === "-") {
    return !(maskedPrefix[index - 1] === character && maskedPrefix[index - 2] !== character);
  }
  if (character === "}") return !isObjectLiteralEnd(maskedPrefix, index);
  if (character === ")") return isControlHeaderEnd(maskedPrefix, index);
  if (character === "/") {
    let before = index - 1;
    while (before >= 0 && (maskedPrefix[before] === " " || maskedPrefix[before] === "\n")) {
      before -= 1;
    }
    return !(before >= 0 && maskedPrefix[before] === "/");
  }
  return character !== "]" && character !== '"' && character !== "'" && character !== "`";
}

function isControlHeaderEnd(maskedPrefix, closeParenIndex) {
  let depth = 0;
  let openParenIndex = -1;
  for (let index = closeParenIndex; index >= 0; index -= 1) {
    const character = maskedPrefix[index];
    if (character === ")") depth += 1;
    else if (character === "(") {
      depth -= 1;
      if (depth === 0) {
        openParenIndex = index;
        break;
      }
    }
  }
  if (openParenIndex <= 0) return false;
  let index = openParenIndex - 1;
  while (index >= 0) {
    const character = maskedPrefix[index];
    if (character === " " || character === "\n" || character === "\t" || character === "\r") {
      index -= 1;
      continue;
    }
    break;
  }
  if (index < 0 || !IDENTIFIER_CHARACTER.test(maskedPrefix[index])) return false;
  let start = index;
  while (start >= 0 && IDENTIFIER_CHARACTER.test(maskedPrefix[start])) start -= 1;
  return PAREN_STATEMENT_KEYWORDS.has(maskedPrefix.slice(start + 1, index + 1));
}

function isObjectLiteralEnd(maskedPrefix, closeBraceIndex) {
  let depth = 0;
  let openBraceIndex = -1;
  for (let index = closeBraceIndex; index >= 0; index -= 1) {
    const character = maskedPrefix[index];
    if (character === "}") depth += 1;
    else if (character === "{") {
      depth -= 1;
      if (depth === 0) {
        openBraceIndex = index;
        break;
      }
    }
  }
  if (openBraceIndex <= 0) return false;
  let index = openBraceIndex - 1;
  while (index >= 0) {
    const character = maskedPrefix[index];
    if (character === " " || character === "\n" || character === "\t" || character === "\r") {
      index -= 1;
      continue;
    }
    break;
  }
  if (index < 0) return false;
  const character = maskedPrefix[index];
  if (IDENTIFIER_CHARACTER.test(character)) {
    let start = index;
    while (start >= 0 && IDENTIFIER_CHARACTER.test(maskedPrefix[start])) start -= 1;
    return OBJECT_PRECEDING_KEYWORDS.has(maskedPrefix.slice(start + 1, index + 1));
  }
  if (character === ")" || character === ";" || character === "{" || character === "}") {
    return false;
  }
  if (character === ">" && maskedPrefix[index - 1] === "=") return false;
  return true;
}

function assertSupportedActionSyntax(source) {
  const maskedSource = maskActionSourceForSyntax(source);
  if (/^\s*import\s/m.test(maskedSource) || /(^|\n)\s*export\s*\{/m.test(maskedSource)) {
    throw new Error(
      "Workflow action files currently support CommonJS require() plus export const/function/default declarations; static import/export lists are not supported"
    );
  }
}

function isTopLevelActionSourceMatch(maskedSource, matchIndex) {
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let index = 0; index < matchIndex; index += 1) {
    switch (maskedSource[index]) {
      case "{":
        braceDepth += 1;
        break;
      case "}":
        braceDepth = Math.max(0, braceDepth - 1);
        break;
      case "[":
        bracketDepth += 1;
        break;
      case "]":
        bracketDepth = Math.max(0, bracketDepth - 1);
        break;
      case "(":
        parenDepth += 1;
        break;
      case ")":
        parenDepth = Math.max(0, parenDepth - 1);
        break;
    }
  }
  return braceDepth === 0 && bracketDepth === 0 && parenDepth === 0;
}

function replaceMaskedExportSyntax(source, pattern, replacementForMatch) {
  const maskedSource = maskActionSourceForSyntax(source);
  let output = "";
  let lastIndex = 0;
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(maskedSource)) !== null) {
    if (!isTopLevelActionSourceMatch(maskedSource, match.index)) {
      continue;
    }
    output += source.slice(lastIndex, match.index);
    output += replacementForMatch(match);
    lastIndex = match.index + match[0].length;
  }
  return output + source.slice(lastIndex);
}

function stripExportSyntax(source) {
  let transformed = source;
  transformed = replaceMaskedExportSyntax(
    transformed,
    /(^|\n)\s*export\s+default\s+/g,
    (match) => match[1] + "const __default = "
  );
  transformed = replaceMaskedExportSyntax(
    transformed,
    /(^|\n)\s*export\s+(async\s+function|function)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    (match) => match[1] + match[2] + " " + match[3]
  );
  transformed = replaceMaskedExportSyntax(
    transformed,
    /(^|\n)\s*export\s+(const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    (match) => match[1] + match[2] + " " + match[3]
  );
  return transformed;
}

async function loadAction(payload) {
  assertSupportedActionSyntax(payload.source);
  const AsyncFunction = Object.getPrototypeOf(async function () {
    return undefined;
  }).constructor;
  const transformedSource = stripExportSyntax(payload.source);
  const actionDir = path.dirname(payload.sourcePath);
  const actionModule = { exports: {} };
  const factory = new AsyncFunction(
    "module",
    "exports",
    "require",
    "process",
    "__filename",
    "__dirname",
    transformedSource +
      "\nreturn {" +
      "metadata: typeof metadata !== 'undefined' ? metadata : module.exports.metadata," +
      "execute: typeof execute !== 'undefined' ? execute : module.exports.execute," +
      "reconcile: typeof reconcile !== 'undefined' ? reconcile : module.exports.reconcile," +
      "default: typeof __default !== 'undefined' ? __default : module.exports.default," +
      "moduleExports: module.exports" +
      "};"
  );
  const loaded = await factory(
    actionModule,
    actionModule.exports,
    createRequire(payload.sourcePath),
    process,
    payload.sourcePath,
    actionDir
  );
  const defaultExport = loaded.default;
  const moduleExports =
    loaded.moduleExports && typeof loaded.moduleExports === "object" ? loaded.moduleExports : {};
  return {
    metadata: loaded.metadata ?? defaultExport?.metadata ?? moduleExports.metadata,
    execute: loaded.execute ?? defaultExport?.execute ?? moduleExports.execute,
    reconcile: loaded.reconcile ?? defaultExport?.reconcile ?? moduleExports.reconcile,
  };
}

function assertSafeArtifactName(name) {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("Artifact name must be a non-empty string");
  }
  if (path.isAbsolute(name) || name.split(/[\\/]+/).includes("..")) {
    throw new Error("Artifact name must stay inside the action artifact directory");
  }
  if (
    path.normalize(name) === ".mux-action-result.json" ||
    path.normalize(name) === ".mux-action-exec-pids.json"
  ) {
    throw new Error("Artifact name is reserved for workflow action internals");
  }
}

function assertExecArgs(command, args) {
  if (typeof command !== "string" || command.length === 0) {
    throw new Error("ctx.exec command must be a non-empty string");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("ctx.exec args must be an array of strings");
  }
}

async function execCheckedCommand(command, args = [], options = {}) {
  const result = await execCommand(command, args, options);
  if (result.stdoutTruncated || result.stderrTruncated) {
    throw new Error("ctx.execChecked command output exceeded workflow action capture limit");
  }
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut === true) {
    throw new Error((result.stderr || result.stdout || "ctx.execChecked command failed").trim());
  }
  return result;
}

async function execJsonCommand(command, args = [], options = {}) {
  const result = await execCheckedCommand(command, args, options);
  try {
    return JSON.parse(result.stdout || "null");
  } catch (error) {
    throw new Error(
      "ctx.execJson failed to parse stdout as JSON: " +
        (error instanceof Error ? error.message : String(error))
    );
  }
}

async function writeTempJson(value, payload, tempDirs) {
  const dir = await fs.mkdtemp(path.join(payload.artifactDir, ".tmp-json-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "payload.json");
  await fs.writeFile(filePath, JSON.stringify(value), "utf-8");
  return { path: filePath, dir };
}

async function cleanupTempDirs(tempDirs) {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function execCommand(command, args = [], options = {}) {
  assertExecArgs(command, args);
  const child = spawn(command, args, {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.pid != null) {
    trackExecPid(options.execPidPath, child.pid);
  }
  const stdout = createCapture();
  const stderr = createCapture();
  let exitCode = null;
  let signal = null;
  let timedOut = false;
  const timeoutMs = options.timeoutMs;
  const killChild = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (child.pid != null) killProcessTree(child.pid);
    else child.kill("SIGKILL");
  };
  const timer =
    typeof timeoutMs === "number" && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killChild();
        }, timeoutMs)
      : null;
  timer?.unref?.();
  child.stdout?.on("data", (chunk) => {
    appendCapture(stdout, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    appendCapture(stderr, chunk);
  });
  child.on("exit", (code, childSignal) => {
    exitCode = code;
    signal = childSignal;
  });
  try {
    await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
  } finally {
    if (timer != null) {
      clearTimeout(timer);
    }
    if (child.pid != null) {
      killProcessTree(child.pid);
      untrackExecPid(options.execPidPath, child.pid);
    }
  }
  const stdoutResult = captureResult(stdout);
  const stderrResult = captureResult(stderr);
  return {
    exitCode,
    signal,
    stdout: stdoutResult.text,
    stderr: stderrResult.text,
    stdoutTruncated: stdoutResult.truncated,
    stderrTruncated: stderrResult.truncated,
    timedOut,
  };
}

async function main() {
  const payload = JSON.parse(await readStdin());
  const artifacts = [];
  const tempDirs = [];
  const writeResult = async (result) => {
    await fs.mkdir(path.dirname(payload.resultPath), { recursive: true });
    const content = JSON.stringify({ attemptId: payload.attemptId, ...result, artifacts });
    if (Buffer.byteLength(content) > RESULT_LIMIT_BYTES) {
      throw new Error("Workflow action result exceeded " + RESULT_LIMIT_BYTES + " bytes");
    }
    await fs.writeFile(payload.resultPath, content, "utf-8");
  };

  try {
    const action = await loadAction(payload);
    const metadata = normalizeMetadata(action.metadata);
    if (payload.mode === "describe") {
      await writeResult({
        success: true,
        metadata,
        hasReconcile: typeof action.reconcile === "function",
      });
      return;
    }

    const fn = payload.mode === "reconcile" ? action.reconcile : action.execute;
    if (typeof fn !== "function") {
      throw new Error(
        payload.mode === "reconcile"
          ? "Workflow action does not export a reconcile function"
          : "Workflow action must export an execute function"
      );
    }

    const context = {
      action: {
        name: payload.actionName,
        sourcePath: payload.sourcePath,
        sourceHash: payload.sourceHash,
        effect: metadata.effect,
      },
      cwd: payload.cwd,
      exec: async (command, args, options = {}) =>
        await execCommand(command, args, {
          cwd: payload.cwd,
          ...options,
          execPidPath: payload.execPidPath,
        }),
      execChecked: async (command, args, options = {}) =>
        await execCheckedCommand(command, args, {
          cwd: payload.cwd,
          ...options,
          execPidPath: payload.execPidPath,
        }),
      execJson: async (command, args, options = {}) =>
        await execJsonCommand(command, args, {
          cwd: payload.cwd,
          ...options,
          execPidPath: payload.execPidPath,
        }),
      writeTempJson: async (value) => await writeTempJson(value, payload, tempDirs),
      writeArtifact: async (name, value) => {
        assertSafeArtifactName(name);
        if (artifacts.length >= MAX_ARTIFACT_COUNT) {
          throw new Error("Workflow action artifact count exceeded " + MAX_ARTIFACT_COUNT);
        }
        const artifactPath = path.join(payload.artifactDir, name);
        await fs.mkdir(path.dirname(artifactPath), { recursive: true });
        const content = typeof value === "string" ? value : JSON.stringify(value, null, 2);
        const sizeBytes = Buffer.byteLength(content);
        if (sizeBytes > MAX_ARTIFACT_BYTES) {
          throw new Error("Workflow action artifact exceeded " + MAX_ARTIFACT_BYTES + " bytes");
        }
        await fs.writeFile(artifactPath, content, "utf-8");
        const artifact = { name, path: artifactPath, sizeBytes };
        artifacts.push(artifact);
        return artifact;
      },
      log: (...args) => console.log(...args),
    };

    const output = await fn(payload.input, context);
    await writeResult({ success: true, metadata, output: output === undefined ? null : output });
  } catch (error) {
    await writeResult({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  } finally {
    await cleanupTempDirs(tempDirs);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
