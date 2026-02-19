import { sanitizeMermaidSvg } from "./Mermaid";

import { Window } from "happy-dom";

const testWindow = new Window();
globalThis.DOMParser = testWindow.DOMParser as unknown as typeof DOMParser;

describe("sanitizeMermaidSvg", () => {
  it("returns null for malformed SVG", () => {
    expect(sanitizeMermaidSvg("<svg><g></svg")).toBeNull();
  });

  it("removes active content and unsafe attributes", () => {
    const input =
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">' +
      "<script>alert(1)</script>" +
      "<foreignObject><div>unsafe</div></foreignObject>" +
      '<a href="javascript:alert(1)"><text>link</text></a>' +
      '<rect width="10" height="10" onclick="steal()" />' +
      "</svg>";

    const sanitized = sanitizeMermaidSvg(input);

    expect(sanitized).not.toBeNull();
    expect(sanitized).not.toContain("<script");
    expect(sanitized).not.toContain("foreignObject");
    expect(sanitized).not.toContain("onload=");
    expect(sanitized).not.toContain("onclick=");
    expect(sanitized).not.toContain("javascript:");
    expect(sanitized).toContain("<svg");
    expect(sanitized).toContain("<rect");
  });
});
