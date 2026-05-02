import { describe, expect, test } from "bun:test";
import type { Element, Root } from "hast";
import { transformWordsForFade } from "./rehypeSplitWordsForFade";

// Drive the transform function directly on a synthetic HAST tree (bypassing
// the unified pipeline). The plugin's transformer is a pure synchronous walk,
// so this keeps the test hermetic and avoids spinning up rehype just to exercise
// node walking + text splitting.
function runPlugin(tree: Root): Root {
  transformWordsForFade(tree);
  return tree;
}

function p(...children: Element["children"]): Element {
  return { type: "element", tagName: "p", properties: {}, children };
}

function root(...children: Root["children"]): Root {
  return { type: "root", children };
}

describe("rehypeSplitWordsForFade", () => {
  test("wraps each whitespace-bounded word in a sd-word span", () => {
    const tree = root(p({ type: "text", value: "Hello world foo" }));
    runPlugin(tree);
    const para = tree.children[0] as Element;
    expect(para.children).toHaveLength(5); // word, space, word, space, word
    const types = para.children.map((c) =>
      c.type === "element"
        ? `<${c.tagName}.${(c.properties?.className as string[]).join(",")}>`
        : c.value
    );
    expect(types).toEqual(["<span.sd-word>", " ", "<span.sd-word>", " ", "<span.sd-word>"]);
  });

  test("preserves whitespace runs as plain text (no spans)", () => {
    const tree = root(p({ type: "text", value: "a  \n  b" }));
    runPlugin(tree);
    const para = tree.children[0] as Element;
    // [span("a"), text("  \n  "), span("b")]
    expect(para.children).toHaveLength(3);
    expect((para.children[0] as Element).tagName).toBe("span");
    expect(para.children[1].type).toBe("text");
    expect(para.children[2].type).toBe("element");
  });

  test("partial trailing word (no whitespace yet) is still wrapped", () => {
    // Mid-stream: text node is "Hel" with nothing after it. Should still wrap
    // so React reconciles the same span as it grows to "Hello".
    const tree = root(p({ type: "text", value: "Hel" }));
    runPlugin(tree);
    const para = tree.children[0] as Element;
    expect(para.children).toHaveLength(1);
    expect((para.children[0] as Element).tagName).toBe("span");
    expect(((para.children[0] as Element).children[0] as { value: string }).value).toBe("Hel");
  });

  test("empty text nodes produce no children", () => {
    const tree = root(p({ type: "text", value: "" }));
    runPlugin(tree);
    const para = tree.children[0] as Element;
    expect(para.children).toEqual([]);
  });

  test("does not split inside <pre> / <code> subtrees", () => {
    // <pre><code>foo bar</code></pre> — must remain a single text node.
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

  test("does not split inside KaTeX subtrees (class includes 'katex')", () => {
    // KaTeX renders as <span class="katex"> with complex inner spans containing
    // single-character text nodes. Splitting them would corrupt math layout.
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
    // Inner text untouched.
    expect(katex.children).toHaveLength(1);
    expect(katex.children[0].type).toBe("text");
    expect((katex.children[0] as { value: string }).value).toBe("x = y + z");
  });

  test("recurses into inline elements like <strong> and <em>", () => {
    // <p>hello <strong>brave new</strong> world</p>
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

    // Outer paragraph: split "hello " → [span("hello"), " "], then <strong> child
    // (its inner "brave new" should be split inside it), then split " world"
    // → [" ", span("world")].
    const outer = para.children;
    // Quick shape check: strong should be at some index, and its inner text
    // should be wrapped in word spans.
    const strongChild = outer.find(
      (c) => c.type === "element" && c.tagName === "strong"
    ) as Element;
    expect(strongChild).toBeDefined();
    expect(strongChild.children).toHaveLength(3); // span("brave"), " ", span("new")
    expect((strongChild.children[0] as Element).tagName).toBe("span");
    expect((strongChild.children[2] as Element).tagName).toBe("span");
  });
});
