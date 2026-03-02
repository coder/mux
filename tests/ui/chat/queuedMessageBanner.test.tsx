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

  test("renders queued preview text and label", () => {
    const view = render(<QueuedMessage message={createQueuedMessage()} />);

    expect(view.getByText("Queued")).toBeTruthy();
    expect(view.getByText("Review this change before sending")).toBeTruthy();
  });

  test("renders an inner queued bubble inside the banner", () => {
    const view = render(<QueuedMessage message={createQueuedMessage()} />);

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

    expect(view.getByText("Edit")).toBeTruthy();
    expect(view.getByText("Send now")).toBeTruthy();
  });

  test("clicking Edit calls onEdit", () => {
    const onEdit = mock(() => {});

    const view = render(<QueuedMessage message={createQueuedMessage()} onEdit={onEdit} />);

    fireEvent.click(view.getByText("Edit"));

    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  test("clicking Send now calls onSendImmediately", async () => {
    const onSendImmediately = mock(async () => {});

    const view = render(
      <QueuedMessage message={createQueuedMessage()} onSendImmediately={onSendImmediately} />
    );

    fireEvent.click(view.getByText("Send now"));

    await waitFor(() => {
      expect(onSendImmediately).toHaveBeenCalledTimes(1);
    });
  });

  test("does not render Send now button when onSendImmediately is absent", () => {
    const view = render(<QueuedMessage message={createQueuedMessage()} onEdit={mock(() => {})} />);

    expect(view.queryByText("Send now")).toBeNull();
  });

  test("shows attachment indicator when fileParts are present", () => {
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

    expect(view.getByText("1 file")).toBeTruthy();
  });

  test("shows review indicator when reviews are present", () => {
    const view = render(
      <QueuedMessage
        message={createQueuedMessage({
          reviews: [
            {
              filePath: "src/example.ts",
              lineRange: "+1-2",
              selectedCode: "const value = 1;",
              userNote: "Double-check this logic.",
            },
          ],
        })}
      />
    );

    expect(view.getByText("1 review")).toBeTruthy();
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
              selectedCode: "const x = 1;",
              userNote: "Fix this",
            },
          ],
        })}
      />
    );

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
              selectedCode: "code",
              userNote: "note",
            },
          ],
        })}
      />
    );

    expect(view.getByText("Do this please")).toBeTruthy();
  });

  test("renders image thumbnails for image file parts", () => {
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

    const images = view.container.querySelectorAll("img");
    expect(images.length).toBe(2);
    expect(images[0]?.getAttribute("src")).toBe("file:///tmp/screenshot.png");
    expect(images[1]?.getAttribute("src")).toBe("file:///tmp/photo.jpg");
  });

  test("limits image thumbnails to three with overflow indicator", () => {
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

    const images = view.container.querySelectorAll("img");
    expect(images.length).toBe(3);
    expect(view.getByText("+2")).toBeTruthy();
  });

  test("file counter only counts non-image attachments", () => {
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

    expect(view.getByText("2 files")).toBeTruthy();
    const images = view.container.querySelectorAll("img");
    expect(images.length).toBe(1);
  });

  test("image-only queue renders thumbnails with no file counter", () => {
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

    const images = view.container.querySelectorAll("img");
    expect(images.length).toBe(2);
    expect(view.getByText("2 images")).toBeTruthy();
    expect(view.queryByText(/\d+ file/)).toBeNull();
  });
});
