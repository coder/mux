import { describe, expect, test } from "bun:test";
import { Protocol } from "@homebridge/ciao";
import type { NetworkInterfaceInfo } from "node:os";
import { buildMuxMdnsServiceOptions, MUX_MDNS_SERVICE_TYPE } from "./mdnsAdvertiserService";

describe("buildMuxMdnsServiceOptions", () => {
  test("0.0.0.0 disables IPv6 and avoids advertising loopback addresses", () => {
    const networkInterfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
      lo0: [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
        },
      ],
      en0: [
        {
          address: "192.168.1.10",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "192.168.1.10/24",
        },
      ],
    };

    const serviceOptions = buildMuxMdnsServiceOptions({
      bindHost: "0.0.0.0",
      port: 3000,
      instanceName: "mux-test",
      version: "0.0.0-test",
      authRequired: true,
      networkInterfaces,
    });

    expect(serviceOptions.type).toBe(MUX_MDNS_SERVICE_TYPE);
    expect(serviceOptions.protocol).toBe(Protocol.TCP);
    expect(serviceOptions.disabledIpv6).toBe(true);
    expect(serviceOptions.restrictedAddresses).toEqual(["en0"]);
  });

  test("IPv6 wildcard avoids advertising loopback addresses", () => {
    const networkInterfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
      lo0: [
        {
          address: "::1",
          netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
          family: "IPv6",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "::1/128",
          scopeid: 0,
        },
      ],
      en0: [
        {
          address: "2001:db8::1",
          netmask: "ffff:ffff:ffff:ffff::",
          family: "IPv6",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "2001:db8::1/64",
          scopeid: 0,
        },
      ],
      awdl0: [
        {
          address: "fe80::1",
          netmask: "ffff:ffff:ffff:ffff::",
          family: "IPv6",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "fe80::1/64",
          scopeid: 0,
        },
      ],
    };

    const serviceOptions = buildMuxMdnsServiceOptions({
      bindHost: "::",
      port: 3000,
      instanceName: "mux-test",
      version: "0.0.0-test",
      authRequired: false,
      networkInterfaces,
    });

    expect(serviceOptions.restrictedAddresses).toEqual(["en0"]);
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
