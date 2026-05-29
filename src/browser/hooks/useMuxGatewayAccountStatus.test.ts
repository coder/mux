import { describe, expect, test } from "bun:test";
import { formatMuxGatewayBalance } from "./useMuxGatewayAccountStatus";

describe("formatMuxGatewayBalance", () => {
  test("formats zero balance", () => {
    expect(formatMuxGatewayBalance(0)).toBe("$0.00");
  });

  test("formats positive balance", () => {
    expect(formatMuxGatewayBalance(5_000_000)).toBe("$5.00");
  });

  test("returns dash for null", () => {
    expect(formatMuxGatewayBalance(null)).toBe("—");
  });

  test("returns dash for undefined", () => {
    expect(formatMuxGatewayBalance(undefined)).toBe("—");
  });
});
