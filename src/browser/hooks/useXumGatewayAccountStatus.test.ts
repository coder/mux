import { describe, expect, test } from "bun:test";
import { formatXumGatewayBalance } from "./useXumGatewayAccountStatus";

describe("formatXumGatewayBalance", () => {
  test("formats zero balance", () => {
    expect(formatXumGatewayBalance(0)).toBe("$0.00");
  });

  test("formats positive balance", () => {
    expect(formatXumGatewayBalance(5_000_000)).toBe("$5.00");
  });

  test("returns dash for null", () => {
    expect(formatXumGatewayBalance(null)).toBe("—");
  });

  test("returns dash for undefined", () => {
    expect(formatXumGatewayBalance(undefined)).toBe("—");
  });
});
