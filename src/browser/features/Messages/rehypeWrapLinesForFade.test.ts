import { describe, expect, test } from "bun:test";
import type { Element, Root } from "hast";
import { transformLinesForFade } from "./rehypeWrapLinesForFade";

// Drive the transform function directly on a synthetic HAST tree (bypassing
// the unified pipeline). The plugin's transformer is a pure synchronous walk,
// so this keeps the test hermetic and avoids spinning up rehype just to
// exercise node walking + text wrapping.
function runPlugin(tree: Root): Root {
  transformLinesForFade(tree);
  return tree;
}

function p(...children: Element["children"]): Element {
  return { type: "element", tagName: "p", properties: {}, children };
}

function root(...children: Root["children"]): Root {
  return { type: "root", children };
}

describe("rehypeWrapLinesForFade", () => {
  test("wraps a paragraph text node in a single sd-line span", () => {
    const tree = root(p({ type: "text", value: "Hello world foo" }));
    runPlugin(tree);
    const para = tree.children[0] as Element;
    // One span, no internal splitting — multi-word content stays as a single
    // unit so words within the same paragraph don't mount/animate
    // independently (the cause of horizontal jitter).
    expect(para.children).toHaveLength(1);
    const span = para.children[0] as Element;
    expect(span.tagName).toBe("span");
    expect(span.properties?.className).toEqual(["sd-line"]);
    expect((span.children[0] as { value: string }).value).toBe("Hello world foo");
  });

  test("treats <br>-separated text nodes as separate lines", () => {
    // remarkBreaks converts `foo\nbar\nbaz` into <p>foo<br>bar<br>baz</p>.
    // Each text node between <br>s should become its own span — that's the
    // line-by-line reveal for reasoning content.
    const br: Element = { type: "element", tagName: "br", properties: {}, children: [] };
    const tree = root(
      p({ type: "text", value: "foo" }, br, { type: "text", value: "bar" }, br, {
        type: "text",
        value: "baz",
      })
    );
    runPlugin(tree);
    const para = tree.children[0] as Element;
    expect(para.children).toHaveLength(5);
    expect((para.children[0] as Element).tagName).toBe("span");
    expect((para.children[1] as Element).tagName).toBe("br");
    expect((para.children[2] as Element).tagName).toBe("span");
    expect((para.children[3] as Element).tagName).toBe("br");
    expect((para.children[4] as Element).tagName).toBe("span");
  });

  test("empty text nodes produce no spans", () => {
    const tree = root(p({ type: "text", value: "" }));
    runPlugin(tree);
    const para = tree.children[0] as Element;
    expect(para.children).toEqual([]);
  });

  test("does not wrap inside <pre> / <code> subtrees", () => {
    const codeBlock: Element = {
      type: "element",
      tagName: "pre",
      properties: {},
      children: [
        {
          type: "element",
          tagName: "code",
          properties: {},
          children: [{ type: "text", value: "foo bar" }],
        },
      ],
    };
    const tree = root(codeBlock);
    runPlugin(tree);
    const pre = tree.children[0] as Element;
    const code = pre.children[0] as Element;
    expect(code.children).toHaveLength(1);
    expect(code.children[0].type).toBe("text");
    expect((code.children[0] as { value: string }).value).toBe("foo bar");
  });

  test("does not wrap inside KaTeX subtrees (class includes 'katex')", () => {
    // Wrapping text inside a KaTeX subtree corrupts math glyph layout.
    const katexNode: Element = {
      type: "element",
      tagName: "span",
      properties: { className: ["katex"] },
      children: [{ type: "text", value: "x = y + z" }],
    };
    const tree = root(p(katexNode));
    runPlugin(tree);
    const para = tree.children[0] as Element;
    const katex = para.children[0] as Element;
    expect(katex.children).toHaveLength(1);
    expect(katex.children[0].type).toBe("text");
    expect((katex.children[0] as { value: string }).value).toBe("x = y + z");
  });

  test("recurses into inline elements like <strong>", () => {
    // <p>hello <strong>brave new</strong> world</p>
    // The strong's inner text node becomes one span (the whole bold phrase
    // is one line unit, not per-word). Surrounding text on either side of
    // <strong> is also each one span.
    const strong: Element = {
      type: "element",
      tagName: "strong",
      properties: {},
      children: [{ type: "text", value: "brave new" }],
    };
    const tree = root(
      p({ type: "text", value: "hello " }, strong, { type: "text", value: " world" })
    );
    runPlugin(tree);
    const para = tree.children[0] as Element;
    expect(para.children).toHaveLength(3);
    expect((para.children[0] as Element).tagName).toBe("span");
    expect((para.children[1] as Element).tagName).toBe("strong");
    expect((para.children[2] as Element).tagName).toBe("span");

    const strongChild = para.children[1] as Element;
    expect(strongChild.children).toHaveLength(1);
    expect((strongChild.children[0] as Element).tagName).toBe("span");
    expect(((strongChild.children[0] as Element).children[0] as { value: string }).value).toBe(
      "brave new"
    );
  });
});
