import { describe, expect, test } from "bun:test";

import { extractShikiLines } from "./shiki-shared";

describe("extractShikiLines", () => {
  test("removes trailing visually-empty Shiki line (e.g. <span></span>)", () => {
    const html = `<pre class="shiki"><code><span class="line"><span style="color:#fff">https://github.com/coder/mux/pull/new/chat-autocomplete-b24r</span></span>
<span class="line"><span style="color:#fff"></span></span>
</code></pre>`;

    expect(extractShikiLines(html)).toEqual([
      `<span style="color:#fff">https://github.com/coder/mux/pull/new/chat-autocomplete-b24r</span>`,
    ]);
  });
});
