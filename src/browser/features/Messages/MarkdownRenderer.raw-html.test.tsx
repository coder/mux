import "../../../../tests/ui/dom";

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { rawHtmlUsesOnlyAllowedTags } from "./MarkdownCore";
import { MarkdownRenderer } from "./MarkdownRenderer";

function renderMarkdown(content: string) {
  return render(<MarkdownRenderer content={content} preserveLineBreaks />);
}

describe("MarkdownRenderer raw HTML handling", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("renders unknown JSX-like tags as literal text", () => {
    const view = renderMarkdown(
      "@clerk/nextjs: You've passed multiple children components to <SignOutButton/>. You can only pass a single child component or text."
    );

    expect(view.container.textContent).toContain("<SignOutButton/>");
    expect(view.container.textContent).toContain("You can only pass a single child component");
    expect(view.container.querySelector("signoutbutton")).toBeNull();
  });

  test("keeps supported collapsible HTML on the raw HTML path", () => {
    expect(rawHtmlUsesOnlyAllowedTags("<details><summary>More</summary>Hidden</details>")).toBe(
      true
    );
  });
});
