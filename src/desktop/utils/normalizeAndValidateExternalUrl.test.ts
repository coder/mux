import { describe, expect, test } from "bun:test";
import { normalizeAndValidateExternalUrl } from "./normalizeAndValidateExternalUrl";

describe("normalizeAndValidateExternalUrl", () => {
  const cases: Array<{
    name: string;
    url: string;
    localhostProxyTemplate?: string;
    expected: string | null;
  }> = [
    {
      name: "allows https URLs",
      url: "https://example.com/docs?tab=security#shell",
      expected: "https://example.com/docs?tab=security#shell",
    },
    {
      name: "rewrites loopback URLs before allowlisting the final proxy URL",
      url: "http://localhost:5173/docs?tab=security#shell",
      localhostProxyTemplate: "https://proxy-{{port}}.example.test",
      expected: "https://proxy-5173.example.test/docs?tab=security#shell",
    },
    {
      name: "blocks file URLs after loopback proxy normalization",
      url: "http://localhost:5173/docs",
      localhostProxyTemplate: "file:///tmp/proxy/{{port}}",
      expected: null,
    },
    {
      name: "blocks javascript URLs",
      url: "javascript:alert(1)",
      expected: null,
    },
    {
      name: "blocks data URLs",
      url: "data:text/html,hello",
      expected: null,
    },
    {
      name: "blocks file URLs",
      url: "file:///tmp/test.txt",
      expected: null,
    },
    {
      name: "blocks vbscript URLs",
      url: "vbscript:msgbox(1)",
      expected: null,
    },
    {
      name: "blocks malformed input",
      url: "not a valid url",
      expected: null,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      expect(
        normalizeAndValidateExternalUrl({
          url: testCase.url,
          localhostProxyTemplate: testCase.localhostProxyTemplate,
        })
      ).toBe(testCase.expected);
    });
  }
});
