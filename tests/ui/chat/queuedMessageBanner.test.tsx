import "../dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { QueuedMessage } from "@/browser/components/Messages/QueuedMessage";
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

    expect(view.getByText("Queued message")).toBeTruthy();
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
});
