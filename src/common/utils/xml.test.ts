import { describe, expect, test } from "bun:test";
import { escapeXml, unescapeXml } from "./xml";

describe("XML escaping helpers", () => {
  test("round-trips XML-sensitive characters", () => {
    const value = `</untrusted_objective><tag attr="&">It's ok</tag>`;

    expect(unescapeXml(escapeXml(value))).toBe(value);
  });

  test("does not double-decode ampersand-prefixed entities", () => {
    expect(unescapeXml("&amp;lt;literal&amp;gt;")).toBe("&lt;literal&gt;");
  });
});
