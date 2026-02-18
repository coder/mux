import assert from "node:assert/strict";
import { AGENT_METHODS, type Stream } from "@agentclientprotocol/sdk";

type StreamMessage = Stream["readable"] extends ReadableStream<infer Message> ? Message : never;
type JsonObject = Record<string, unknown>;
type RequestId = string | number | null;

interface JsonRpcResponseEnvelope extends JsonObject {
  id: RequestId;
  result?: unknown;
  error?: unknown;
}

interface JsonRpcNotificationEnvelope extends JsonObject {
  method: string;
  params?: unknown;
}

/**
 * Wraps an ACP Stream with compatibility handling for clients that send
 * raw params objects without JSON-RPC 2.0 framing.
 *
 * Incoming (client → agent):
 * - First message decides compatibility mode.
 * - Legacy mode is enabled when the first message is not JSON-RPC framed.
 * - Legacy messages are wrapped into JSON-RPC requests when the ACP method
 *   can be inferred from the payload shape.
 *
 * Outgoing (agent → client):
 * - In legacy mode, unwrap responses for auto-wrapped requests.
 * - In legacy mode, unwrap notifications into `{ method, ...params }` payloads.
 */
export function createCompatStream(baseStream: Stream): Stream {
  assert(baseStream != null, "createCompatStream: base stream is required");

  let legacyMode: boolean | null = null;
  let nextRequestId = 0;
  const autoAssignedIds = new Set<RequestId>();

  const incomingTransform = new TransformStream<StreamMessage, StreamMessage>({
    transform(message, controller) {
      const isFramedJsonRpc = isJsonRpcMessage(message);

      if (legacyMode == null) {
        legacyMode = !isFramedJsonRpc;
        if (legacyMode) {
          console.error("[acp-compat] Detected legacy ACP client mode from first inbound message");
        }
      }

      if (!legacyMode) {
        controller.enqueue(message);
        return;
      }

      if (isFramedJsonRpc) {
        controller.enqueue(message);
        return;
      }

      if (!isJsonObject(message)) {
        console.error("[acp-compat] Legacy inbound message was not an object; passing through");
        controller.enqueue(message);
        return;
      }

      const method = inferAcpMethod(message);
      if (method == null) {
        console.error("[acp-compat] Could not infer ACP method from legacy inbound message");
        controller.enqueue(message);
        return;
      }

      const id = nextRequestId;
      nextRequestId += 1;
      assert(
        Number.isSafeInteger(id),
        "createCompatStream: auto request id must be a safe integer"
      );
      assert(id >= 0, "createCompatStream: auto request id must be non-negative");

      autoAssignedIds.add(id);
      console.error(
        `[acp-compat] Wrapped legacy inbound message as JSON-RPC request (method=${method}, id=${id})`
      );

      const wrappedMessage: JsonObject = {
        jsonrpc: "2.0",
        id,
        method,
        params: message,
      };
      controller.enqueue(wrappedMessage as StreamMessage);
    },
  });

  const outgoingTransform = new TransformStream<StreamMessage, StreamMessage>({
    transform(message, controller) {
      if (!legacyMode || !isJsonObject(message)) {
        controller.enqueue(message);
        return;
      }

      if (isLegacyResponseEnvelope(message, autoAssignedIds)) {
        autoAssignedIds.delete(message.id);

        if ("result" in message) {
          console.error(
            `[acp-compat] Unwrapped JSON-RPC result for legacy client (id=${String(message.id)})`
          );
          controller.enqueue(message.result as StreamMessage);
          return;
        }

        if ("error" in message) {
          console.error(
            `[acp-compat] Unwrapped JSON-RPC error for legacy client (id=${String(message.id)})`
          );
          controller.enqueue(message.error as StreamMessage);
          return;
        }
      }

      if (isJsonRpcNotificationEnvelope(message)) {
        const unwrappedNotification = unwrapLegacyNotification(message);
        console.error(
          `[acp-compat] Unwrapped JSON-RPC notification for legacy client (method=${message.method})`
        );
        controller.enqueue(unwrappedNotification as StreamMessage);
        return;
      }

      controller.enqueue(message);
    },
  });

  const outgoingPipe = outgoingTransform.readable.pipeTo(baseStream.writable);
  outgoingPipe.catch((error: unknown) => {
    console.error("[acp-compat] Outbound compatibility pipe failed", error);
  });

  return {
    readable: baseStream.readable.pipeThrough(incomingTransform),
    writable: outgoingTransform.writable,
  };
}

/**
 * Returns true when an incoming message appears JSON-RPC-framed.
 */
function isJsonRpcMessage(message: unknown): boolean {
  if (!isJsonObject(message)) {
    return false;
  }

  return "jsonrpc" in message || "method" in message || "id" in message;
}

/**
 * Infers the ACP method name from the shape of a raw params object.
 */
function inferAcpMethod(message: JsonObject): string | null {
  if ("protocolVersion" in message) {
    return AGENT_METHODS.initialize;
  }

  if ("methodId" in message || "authMethod" in message) {
    return AGENT_METHODS.authenticate;
  }

  if ("sessionId" in message && "prompt" in message) {
    return AGENT_METHODS.session_prompt;
  }

  if ("sessionId" in message && "configId" in message) {
    return AGENT_METHODS.session_set_config_option;
  }

  if ("sessionId" in message && ("modeId" in message || "mode" in message)) {
    return AGENT_METHODS.session_set_mode;
  }

  if ("sessionId" in message && ("modelId" in message || "model" in message)) {
    return AGENT_METHODS.session_set_model;
  }

  if ("sessionId" in message && "forkPoint" in message) {
    return AGENT_METHODS.session_fork;
  }

  if ("sessionId" in message && "cwd" in message) {
    return AGENT_METHODS.session_load;
  }

  if (("cwd" in message || "_meta" in message) && !("sessionId" in message)) {
    return AGENT_METHODS.session_new;
  }

  if ("sessionId" in message) {
    return AGENT_METHODS.session_cancel;
  }

  return null;
}

function isLegacyResponseEnvelope(
  message: JsonObject,
  autoAssignedIds: ReadonlySet<RequestId>
): message is JsonRpcResponseEnvelope {
  if (!("id" in message)) {
    return false;
  }

  const id = message.id;
  if (typeof id !== "string" && typeof id !== "number" && id !== null) {
    return false;
  }

  if (!autoAssignedIds.has(id)) {
    return false;
  }

  return "result" in message || "error" in message;
}

function isJsonRpcNotificationEnvelope(
  message: JsonObject
): message is JsonRpcNotificationEnvelope {
  if (!("method" in message) || typeof message.method !== "string") {
    return false;
  }

  return !("id" in message);
}

function unwrapLegacyNotification(message: JsonRpcNotificationEnvelope): JsonObject {
  if (!isJsonObject(message.params)) {
    if (message.params === undefined) {
      return { method: message.method };
    }

    return {
      method: message.method,
      params: message.params,
    };
  }

  return {
    ...message.params,
    method: message.method,
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return value != null && typeof value === "object";
}
