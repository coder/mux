import assert from "@/common/utils/assert";
import {
  getResponder,
  Protocol,
  ServiceEvent,
  type CiaoService,
  type Responder,
  type ServiceOptions,
} from "@homebridge/ciao";
import * as net from "node:net";
import { log } from "./log";

// NOTE: Avoid "mux" here: it's an IANA-registered service name ("Multiplexing Protocol"),
// and some discovery tools will display/handle it specially.
export const MUX_MDNS_SERVICE_TYPE = "mux-api";

type ServiceTxtRecord = Record<string, string>;

export interface BuildMuxMdnsServiceOptions {
  bindHost: string;
  port: number;
  instanceName: string;
  version: string;
  authRequired: boolean;
}

export function buildMuxMdnsServiceOptions(options: BuildMuxMdnsServiceOptions): ServiceOptions {
  const bindHost = options.bindHost.trim();
  assert(bindHost, "bindHost is required");

  assert(
    Number.isInteger(options.port) && options.port >= 1 && options.port <= 65535,
    "invalid port"
  );

  const instanceName = options.instanceName.trim();
  assert(instanceName, "instanceName is required");

  const version = options.version.trim();
  assert(version, "version is required");

  const txt: ServiceTxtRecord = {
    path: "/orpc",
    wsPath: "/orpc/ws",
    version,
    authRequired: options.authRequired ? "1" : "0",
  };

  // Keep TXT payload intentionally small (think: "hints", not configuration).
  // DNS-SD TXT uses an array of length-prefixed strings; this is a rough budget check.
  const txtBytes = Object.entries(txt)
    .map(([k, v]) => Buffer.byteLength(`${k}=${v}`, "utf8"))
    .reduce((a, b) => a + b, 0);
  assert(txtBytes <= 512, `TXT record too large (${txtBytes} bytes)`);

  const serviceOptions: ServiceOptions = {
    name: instanceName,
    type: MUX_MDNS_SERVICE_TYPE,
    protocol: Protocol.TCP,
    port: options.port,
    txt,
  };

  // If mux is bound to IPv4 wildcard only, don't advertise IPv6 addresses.
  if (bindHost === "0.0.0.0") {
    serviceOptions.disabledIpv6 = true;
  } else if (bindHost !== "::" && net.isIP(bindHost)) {
    // If mux is bound to a specific IP, only advertise that address (otherwise clients may
    // discover an address that doesn't accept connections).
    serviceOptions.restrictedAddresses = [bindHost];
  }

  return serviceOptions;
}

function stableTxtKey(txt: ServiceTxtRecord): string {
  return Object.entries(txt)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

function stableServiceKey(options: ServiceOptions): string {
  const restricted = options.restrictedAddresses
    ? [...options.restrictedAddresses].sort().join(",")
    : "";
  const txt =
    options.txt && typeof options.txt === "object"
      ? stableTxtKey(options.txt as ServiceTxtRecord)
      : "";
  return [
    options.name,
    options.type,
    options.protocol ?? "tcp",
    String(options.port ?? ""),
    restricted,
    String(options.disabledIpv6 ?? false),
    txt,
  ].join("|");
}

export class MdnsAdvertiserService {
  private responder: Responder | null = null;
  private service: CiaoService | null = null;
  private advertisedKey: string | null = null;
  private chain: Promise<void> = Promise.resolve();

  private enqueue(fn: () => Promise<void>): Promise<void> {
    // Ensure a failed operation doesn't poison future start/stop calls.
    this.chain = this.chain
      .catch((err) => {
        log.warn("mDNS advertiser previous operation failed:", err);
      })
      .then(fn);
    return this.chain;
  }

  start(serviceOptions: ServiceOptions): Promise<void> {
    assert(serviceOptions.name, "serviceOptions.name is required");
    assert(serviceOptions.type, "serviceOptions.type is required");

    return this.enqueue(async () => {
      const nextKey = stableServiceKey(serviceOptions);

      if (this.service && this.advertisedKey === nextKey) {
        return;
      }

      // If anything relevant changed (port, type, name, restrictions), republish.
      if (this.service) {
        await this.service.destroy();
        this.service = null;
        this.advertisedKey = null;
      }

      this.responder ??= getResponder();
      const responder = this.responder;
      assert(responder, "responder must be initialized");

      const service = responder.createService(serviceOptions);
      service.on(ServiceEvent.NAME_CHANGED, (name) => {
        log.info(`mDNS service name changed due to conflict: ${name}`);
      });
      service.on(ServiceEvent.HOSTNAME_CHANGED, (hostname) => {
        log.info(`mDNS hostname changed due to conflict: ${hostname}`);
      });

      await service.advertise();

      log.info("mDNS service advertised", {
        name: serviceOptions.name,
        type: serviceOptions.type,
        protocol: serviceOptions.protocol ?? "tcp",
        port: serviceOptions.port,
        restrictedAddresses: serviceOptions.restrictedAddresses,
        disabledIpv6: serviceOptions.disabledIpv6,
        txt: serviceOptions.txt,
      });

      this.service = service;
      this.advertisedKey = nextKey;
    });
  }

  stop(): Promise<void> {
    return this.enqueue(async () => {
      const service = this.service;
      this.service = null;
      this.advertisedKey = null;

      if (service) {
        await service.destroy();
      }

      const responder = this.responder;
      this.responder = null;

      if (responder) {
        await responder.shutdown();
      }

      if (service || responder) {
        log.info("mDNS service stopped");
      }
    });
  }
}
