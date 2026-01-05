import { describe, expect, test } from "bun:test";
import { Protocol } from "@homebridge/ciao";
import { buildMuxMdnsServiceOptions, MUX_MDNS_SERVICE_TYPE } from "./mdnsAdvertiserService";

describe("buildMuxMdnsServiceOptions", () => {
  test("0.0.0.0 disables IPv6 and does not restrict addresses", () => {
    const serviceOptions = buildMuxMdnsServiceOptions({
      bindHost: "0.0.0.0",
      port: 3000,
      instanceName: "mux-test",
      version: "0.0.0-test",
      authRequired: true,
    });

    expect(serviceOptions.type).toBe(MUX_MDNS_SERVICE_TYPE);
    expect(serviceOptions.protocol).toBe(Protocol.TCP);
    expect(serviceOptions.disabledIpv6).toBe(true);
    expect(serviceOptions.restrictedAddresses).toBeUndefined();
  });

  test("IPv6 wildcard does not restrict addresses", () => {
    const serviceOptions = buildMuxMdnsServiceOptions({
      bindHost: "::",
      port: 3000,
      instanceName: "mux-test",
      version: "0.0.0-test",
      authRequired: false,
    });

    expect(serviceOptions.restrictedAddresses).toBeUndefined();
    expect(serviceOptions.disabledIpv6).toBeUndefined();
  });

  test("specific IP restricts addresses", () => {
    const serviceOptions = buildMuxMdnsServiceOptions({
      bindHost: "192.168.1.10",
      port: 3000,
      instanceName: "mux-test",
      version: "0.0.0-test",
      authRequired: false,
    });

    expect(serviceOptions.restrictedAddresses).toEqual(["192.168.1.10"]);
    expect(serviceOptions.disabledIpv6).toBeUndefined();
  });
});
