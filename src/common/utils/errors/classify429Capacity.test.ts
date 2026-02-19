import { describe, expect, test } from "bun:test";
import { classify429Capacity } from "./classify429Capacity";

describe("classify429Capacity", () => {
  test("classifies insufficient_quota in data as quota", () => {
    expect(
      classify429Capacity({
        data: { error: { code: "insufficient_quota", message: "Please add credits" } },
      })
    ).toBe("quota");
  });

  test("classifies insufficient_quota in responseBody as quota", () => {
    expect(
      classify429Capacity({
        responseBody: '{"error":{"code":"insufficient_quota","message":"Please add credits"}}',
      })
    ).toBe("quota");
  });

  test("classifies payment/credits language as quota", () => {
    expect(
      classify429Capacity({
        message: "Payment required. Insufficient balance; please add credits to continue.",
      })
    ).toBe("quota");
  });

  test("classifies billing language as quota", () => {
    expect(classify429Capacity({ message: "Billing hard limit reached" })).toBe("quota");
  });

  test("classifies throttling mentioning quota limits as rate_limit", () => {
    expect(classify429Capacity({ message: "Per-minute quota limit reached. Retry in 10s." })).toBe(
      "rate_limit"
    );
  });

  test("classifies generic 429 as rate_limit", () => {
    expect(classify429Capacity({ message: "Too Many Requests" })).toBe("rate_limit");
  });

  test("handles null/missing fields gracefully", () => {
    expect(classify429Capacity({})).toBe("rate_limit");
    expect(classify429Capacity({ message: null, responseBody: null, data: null })).toBe(
      "rate_limit"
    );
  });
});
