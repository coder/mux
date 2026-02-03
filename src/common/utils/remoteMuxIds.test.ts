import {
  decodeRemoteWorkspaceId,
  encodeRemoteWorkspaceId,
  isRemoteWorkspaceId,
} from "./remoteMuxIds";

describe("remoteMuxIds", () => {
  it("roundtrips serverId + remoteId and is filesystem-safe", () => {
    const cases: Array<{ serverId: string; remoteId: string }> = [
      { serverId: "server-1", remoteId: "workspace-123" },
      { serverId: "srv with spaces", remoteId: "remote id with spaces" },
      { serverId: "srv/with/slashes", remoteId: "id\\with\\backslashes" },
      { serverId: "ユニコード", remoteId: "emoji 🚀 + symbols <>:*?" },
    ];

    for (const { serverId, remoteId } of cases) {
      const encoded = encodeRemoteWorkspaceId(serverId, remoteId);
      expect(encoded).not.toMatch(/[:/\\]/);

      const decoded = decodeRemoteWorkspaceId(encoded);
      expect(decoded).toEqual({ serverId, remoteId });

      expect(isRemoteWorkspaceId(encoded)).toBe(true);
    }
  });

  it("rejects invalid inputs when encoding", () => {
    expect(() => encodeRemoteWorkspaceId("", "x")).toThrow();
    expect(() => encodeRemoteWorkspaceId("x", "")).toThrow();

    // Runtime misuse: defensive assertions should catch non-string inputs.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => encodeRemoteWorkspaceId(123 as any, "x")).toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => encodeRemoteWorkspaceId("x", null as any)).toThrow();
  });

  it("returns null for non-remote or malformed ids", () => {
    expect(decodeRemoteWorkspaceId("a1b2c3d4e5")).toBeNull();
    expect(isRemoteWorkspaceId("a1b2c3d4e5")).toBe(false);

    // Wrong prefix / missing parts
    expect(decodeRemoteWorkspaceId("remote")).toBeNull();
    expect(decodeRemoteWorkspaceId("remote.")).toBeNull();

    // Too many separators
    expect(decodeRemoteWorkspaceId("remote.a.b.c")).toBeNull();

    // Invalid base64url components
    expect(decodeRemoteWorkspaceId("remote.!!!!.bbbb")).toBeNull();
    expect(decodeRemoteWorkspaceId("remote.aaaa.****")).toBeNull();

    // base64url length that can never be valid (len % 4 === 1)
    expect(decodeRemoteWorkspaceId("remote.a.bbb")).toBeNull();
  });
});
