import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { CodexOauthWarningBanner } from "./CodexOauthWarningBanner";

describe("CodexOauthWarningBanner", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("renders when GPT-5.3 Codex is selected and OAuth is not connected", () => {
    const onOpenProviders = mock(() => undefined);

    const view = render(
      <CodexOauthWarningBanner
        activeModel="openai:gpt-5.3-codex"
        codexOauthSet={false}
        onOpenProviders={onOpenProviders}
      />
    );

    expect(view.getByTestId("codex-oauth-warning-banner")).toBeTruthy();
    expect(view.getByText("GPT-5.3 Codex OAuth is not connected.")).toBeTruthy();
    expect(view.getByText("Providers")).toBeTruthy();

    fireEvent.click(view.getByText("Providers"));
    expect(onOpenProviders).toHaveBeenCalledTimes(1);
  });

  test("does not render when Codex OAuth is connected", () => {
    const view = render(
      <CodexOauthWarningBanner
        activeModel="openai:gpt-5.3-codex"
        codexOauthSet={true}
        onOpenProviders={() => undefined}
      />
    );

    expect(view.queryByTestId("codex-oauth-warning-banner")).toBeNull();
  });

  test("does not render when Codex OAuth status is still unknown", () => {
    const view = render(
      <CodexOauthWarningBanner
        activeModel="openai:gpt-5.3-codex"
        codexOauthSet={null}
        onOpenProviders={() => undefined}
      />
    );

    expect(view.queryByTestId("codex-oauth-warning-banner")).toBeNull();
  });

  test("does not render for non-required models", () => {
    const view = render(
      <CodexOauthWarningBanner
        activeModel="openai:gpt-5.2"
        codexOauthSet={false}
        onOpenProviders={() => undefined}
      />
    );

    expect(view.queryByTestId("codex-oauth-warning-banner")).toBeNull();
  });
});
