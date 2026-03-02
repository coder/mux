import "../dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { QueuedMessage } from "@/browser/features/Messages/QueuedMessage";
import type { QueuedMessage as QueuedMessageData } from "@/common/types/message";
import { installDom } from "../dom";

function createQueuedMessage(overrides?: Partial<QueuedMessageData>): QueuedMessageData {
  return {
    id: "queued-message-1",
    content: "Review this change before sending",
    ...overrides,
  };
}

function expandQueuedMessage(view: ReturnType<typeof render>) {
  if (view.container.querySelector('[data-component="QueuedMessageCard"]')) {
    return;
  }

  const header = view.getByRole("button", { name: /queued/i });
  fireEvent.click(header);
}

describe("QueuedMessage banner", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("starts expanded — body content is visible", () => {
    const view = render(
      <QueuedMessage
        message={createQueuedMessage()}
        onEdit={mock(() => {})}
        onSendImmediately={mock(async () => {})}
      />
    );

    expect(view.getByRole("button", { name: /queued/i })).toBeTruthy();
    expect(view.getByText("Review this change before sending")).toBeTruthy();
    expect(view.getByText("Edit")).toBeTruthy();
  });

  test("collapses and re-expands on header click", () => {
    const view = render(<QueuedMessage message={createQueuedMessage()} onEdit={mock(() => {})} />);

    const header = view.getByRole("button", { name: /queued/i });
    fireEvent.click(header);
    expect(view.queryByText("Review this change before sending")).toBeNull();
    expect(view.queryByText("Edit")).toBeNull();

    fireEvent.click(header);
    expect(view.getByText("Review this change before sending")).toBeTruthy();
  });

  test("renders queued preview text and label", () => {
    const view = render(<QueuedMessage message={createQueuedMessage()} />);

    expect(view.getByText("Queued")).toBeTruthy();
    expandQueuedMessage(view);
    expect(view.getByText("Review this change before sending")).toBeTruthy();
  });

  test("renders an inner queued bubble inside the banner", () => {
    const view = render(<QueuedMessage message={createQueuedMessage()} />);

    expandQueuedMessage(view);
    const banner = view.container.querySelector('[data-component="QueuedMessageBanner"]');
    const bubble = view.container.querySelector('[data-component="QueuedMessageCard"]');

    expect(banner).toBeTruthy();
    expect(bubble).toBeTruthy();
  });

  test("shows Edit and Send now buttons when handlers are provided", () => {
    const onEdit = mock(() => {});
    const onSendImmediately = mock(async () => {});

    const view = render(
      <QueuedMessage
        message={createQueuedMessage()}
        onEdit={onEdit}
        onSendImmediately={onSendImmediately}
      />
    );

    expandQueuedMessage(view);
    expect(view.getByText("Edit")).toBeTruthy();
    expect(view.getByText("Send now")).toBeTruthy();
  });

  test("clicking Edit calls onEdit", () => {
    const onEdit = mock(() => {});

    const view = render(<QueuedMessage message={createQueuedMessage()} onEdit={onEdit} />);

    expandQueuedMessage(view);
    fireEvent.click(view.getByText("Edit"));

    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  test("clicking Send now calls onSendImmediately", async () => {
    const onSendImmediately = mock(async () => {});

    const view = render(
      <QueuedMessage message={createQueuedMessage()} onSendImmediately={onSendImmediately} />
    );

    expandQueuedMessage(view);
    fireEvent.click(view.getByText("Send now"));

    await waitFor(() => {
      expect(onSendImmediately).toHaveBeenCalledTimes(1);
    });
  });

  test("does not render Send now button when onSendImmediately is absent", () => {
    const view = render(<QueuedMessage message={createQueuedMessage()} onEdit={mock(() => {})} />);

    expandQueuedMessage(view);
    expect(view.queryByText("Send now")).toBeNull();
  });

  test("renders file attachment links when non-image fileParts are present", () => {
    const view = render(
      <QueuedMessage
        message={createQueuedMessage({
          fileParts: [
            {
              url: "file:///tmp/example.ts",
              mediaType: "text/plain",
              filename: "example.ts",
            },
          ],
        })}
      />
    );

    expandQueuedMessage(view);
    expect(view.getByRole("link", { name: "example.ts" })).toBeTruthy();
  });

  test("renders review content inline when reviews are present", () => {
    const view = render(
      <QueuedMessage
        message={createQueuedMessage({
          reviews: [
            {
              filePath: "src/example.ts",
              lineRange: "+1-2",
              selectedCode: "",
              userNote: "Double-check this logic.",
            },
          ],
        })}
      />
    );

    expandQueuedMessage(view);
    expect(view.getByText(/src\/example\.ts/)).toBeTruthy();
    expect(view.getByText("Double-check this logic.")).toBeTruthy();
  });

  test("strips serialized review payload from preview text", () => {
    const view = render(
      <QueuedMessage
        message={createQueuedMessage({
          content:
            "<review>\nRe src/example.ts:+1-2\n```\nconst x = 1;\n```\n> Fix this\n</review>\n\nPlease also check the tests",
          reviews: [
            {
              filePath: "src/example.ts",
              lineRange: "+1-2",
              selectedCode: "",
              userNote: "Fix this",
            },
          ],
        })}
      />
    );

    expandQueuedMessage(view);
    expect(view.queryByText(/Re src\/example\.ts/)).toBeNull();
    expect(view.queryByText(/<review>/)).toBeNull();
    expect(view.getByText("Please also check the tests")).toBeTruthy();
  });

  test("preserves user text when reviews are stripped", () => {
    const view = render(
      <QueuedMessage
        message={createQueuedMessage({
          content: "<review>\nRe a.ts:+1-2\n```\ncode\n```\n> note\n</review>\n\nDo this please",
          reviews: [
            {
              filePath: "a.ts",
              lineRange: "+1-2",
              selectedCode: "",
              userNote: "note",
            },
          ],
        })}
      />
    );

    expandQueuedMessage(view);
    expect(view.getByText("Do this please")).toBeTruthy();
  });

  test("renders combined text, reviews, and attachments via UserMessageContent", () => {
    const view = render(
      <QueuedMessage
        message={createQueuedMessage({
          content:
            "<review>\nRe src/App.tsx:+12-14\n```\nconst ready = true;\n```\n> Please validate edge cases\n</review>\n\nPlease review the bundle output",
          reviews: [
            {
              filePath: "src/App.tsx",
              lineRange: "+12-14",
              selectedCode: "",
              userNote: "Please validate edge cases",
            },
          ],
          fileParts: [
            {
              url: "file:///tmp/screenshot.png",
              mediaType: "image/png",
              filename: "screenshot.png",
            },
            { url: "file:///tmp/data.json", mediaType: "application/json", filename: "data.json" },
          ],
        })}
      />
    );

    expandQueuedMessage(view);
    expect(view.getByText("Please review the bundle output")).toBeTruthy();
    expect(view.getByText(/src\/App\.tsx/)).toBeTruthy();
    expect(view.getByText("Please validate edge cases")).toBeTruthy();
    expect(view.getByRole("link", { name: "data.json" })).toBeTruthy();
    expect(view.getByAltText("Attachment 1")).toBeTruthy();
  });

  test("renders image attachments using attachment alt text", () => {
    const view = render(
      <QueuedMessage
        message={createQueuedMessage({
          content: "Check these screenshots",
          fileParts: [
            {
              url: "file:///tmp/screenshot.png",
              mediaType: "image/png",
              filename: "screenshot.png",
            },
            { url: "file:///tmp/photo.jpg", mediaType: "image/jpeg", filename: "photo.jpg" },
          ],
        })}
      />
    );

    expandQueuedMessage(view);
    const images = view.container.querySelectorAll("img");
    expect(images.length).toBe(2);
    expect(view.getByAltText("Attachment 1")).toBeTruthy();
    expect(view.getByAltText("Attachment 2")).toBeTruthy();
    expect(images[0]?.getAttribute("src")).toBe("file:///tmp/screenshot.png");
    expect(images[1]?.getAttribute("src")).toBe("file:///tmp/photo.jpg");
  });

  test("renders all image attachments without overflow counters", () => {
    const view = render(
      <QueuedMessage
        message={createQueuedMessage({
          fileParts: [
            { url: "file:///tmp/1.png", mediaType: "image/png" },
            { url: "file:///tmp/2.png", mediaType: "image/png" },
            { url: "file:///tmp/3.png", mediaType: "image/png" },
            { url: "file:///tmp/4.png", mediaType: "image/png" },
            { url: "file:///tmp/5.png", mediaType: "image/png" },
          ],
        })}
      />
    );

    expandQueuedMessage(view);
    const images = view.container.querySelectorAll("img");
    expect(images.length).toBe(5);
    expect(view.getByAltText("Attachment 5")).toBeTruthy();
    expect(view.queryByText("+2")).toBeNull();
  });

  test("renders mixed image and file attachments inline", () => {
    const view = render(
      <QueuedMessage
        message={createQueuedMessage({
          fileParts: [
            {
              url: "file:///tmp/screenshot.png",
              mediaType: "image/png",
              filename: "screenshot.png",
            },
            { url: "file:///tmp/data.csv", mediaType: "text/csv", filename: "data.csv" },
            { url: "file:///tmp/doc.pdf", mediaType: "application/pdf", filename: "doc.pdf" },
          ],
        })}
      />
    );

    expandQueuedMessage(view);
    const images = view.container.querySelectorAll("img");
    expect(images.length).toBe(1);
    expect(view.getByAltText("Attachment 1")).toBeTruthy();
    expect(view.getByRole("link", { name: "data.csv" })).toBeTruthy();
    expect(view.getByRole("link", { name: "doc.pdf" })).toBeTruthy();
  });

  test("image-only queue uses fallback text and attachment rendering", () => {
    const view = render(
      <QueuedMessage
        message={createQueuedMessage({
          content: "",
          fileParts: [
            { url: "file:///tmp/a.png", mediaType: "image/png" },
            { url: "file:///tmp/b.jpg", mediaType: "image/jpeg" },
          ],
        })}
      />
    );

    expandQueuedMessage(view);
    const images = view.container.querySelectorAll("img");
    expect(images.length).toBe(2);
    expect(view.getByText("Queued message ready")).toBeTruthy();
    expect(view.getByAltText("Attachment 1")).toBeTruthy();
    expect(view.getByAltText("Attachment 2")).toBeTruthy();
    expect(view.queryByText(/\d+ file/)).toBeNull();
    expect(view.queryByText(/\d+ image/)).toBeNull();
  });
});
