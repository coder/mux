import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";

import { ChatInput } from "./index";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { getInputImagesKey } from "@/common/constants/storage";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal mocks to keep ChatInput renderable in unit tests.
// We only care that image drafts are restored + persisted; other UI is out of scope.
// ─────────────────────────────────────────────────────────────────────────────

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({ api: null }),
}));

void mock.module("@/browser/contexts/SettingsContext", () => ({
  useSettings: () => ({ open: () => undefined }),
}));

void mock.module("@/browser/contexts/WorkspaceContext", () => ({
  useWorkspaceContext: () => ({ selectedWorkspace: null }),
}));

void mock.module("@/browser/contexts/ModeContext", () => ({
  useMode: () => ["exec", () => undefined],
}));

void mock.module("@/browser/hooks/useSendMessageOptions", () => ({
  useSendMessageOptions: () => ({
    model: "test-model",
    baseModel: "test-model",
    thinkingLevel: "off",
    mode: "exec",
    toolPolicy: [],
    providerOptions: undefined,
    experiments: {},
  }),
}));

void mock.module("@/browser/hooks/useModelsFromSettings", () => ({
  useModelsFromSettings: () => ({
    models: ["test-model"],
    customModels: [],
    hiddenModels: [],
    hideModel: () => undefined,
    unhideModel: () => undefined,
    ensureModelInSettings: () => undefined,
    defaultModel: "test-model",
    setDefaultModel: () => undefined,
  }),
}));

void mock.module("@/browser/hooks/useTelemetry", () => ({
  useTelemetry: () => ({ messageSent: () => undefined }),
}));

void mock.module("@/browser/contexts/TutorialContext", () => ({
  useTutorial: () => ({ startSequence: () => undefined }),
}));

void mock.module("@/browser/hooks/useVoiceInput", () => ({
  useVoiceInput: () => ({
    shouldShowUI: false,
    isApiKeySet: false,
    state: "idle",
    mediaRecorder: null,
    requiresSecureContext: false,
    toggle: () => undefined,
    start: () => undefined,
  }),
}));

void mock.module("@/browser/components/ChatInput/useCreationWorkspace", () => ({
  useCreationWorkspace: () => ({
    isSending: false,
    handleSend: () => Promise.resolve(false),
  }),
}));

void mock.module("@/browser/components/ui/tooltip", () => ({
  TooltipProvider: (props: { children: React.ReactNode }) => <>{props.children}</>,
  Tooltip: (props: { children: React.ReactNode }) => <>{props.children}</>,
  TooltipTrigger: (props: { children: React.ReactNode }) => <>{props.children}</>,
  TooltipContent: (_props: unknown) => null,
  HelpIndicator: (_props: unknown) => null,
}));

void mock.module("@/browser/components/ModeSelector", () => ({
  ModeSelector: () => null,
}));

void mock.module("@/browser/components/ModelSettings", () => ({
  ModelSettings: () => null,
}));

void mock.module("@/browser/components/ThinkingSlider", () => ({
  ThinkingSliderComponent: () => null,
}));

void mock.module("@/browser/components/ModelSelector", () => {
  const MockModelSelector = React.forwardRef((_props: unknown, _ref: unknown) => null);
  MockModelSelector.displayName = "MockModelSelector";
  return { ModelSelector: MockModelSelector };
});

void mock.module("@/browser/components/ChatInput/VoiceInputButton", () => ({
  VoiceInputButton: () => null,
}));

void mock.module("@/browser/components/ChatInput/RecordingOverlay", () => ({
  RecordingOverlay: () => null,
}));

void mock.module("@/browser/components/VimTextArea", () => {
  const MockVimTextArea = React.forwardRef(
    (
      props: {
        value: string;
        onChange: (next: string) => void;
        mode: string;
        isEditing?: boolean;
        suppressKeys?: string[];
        trailingAction?: React.ReactNode;
        onEscapeInNormalMode?: () => void;
      } & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value">,
      ref: React.ForwardedRef<HTMLTextAreaElement>
    ) => {
      const {
        value,
        onChange,
        mode: _mode,
        isEditing: _isEditing,
        suppressKeys: _suppressKeys,
        trailingAction: _trailingAction,
        onEscapeInNormalMode: _onEscapeInNormalMode,
        ...rest
      } = props;

      return (
        <textarea
          {...rest}
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      );
    }
  );
  MockVimTextArea.displayName = "MockVimTextArea";
  return { VimTextArea: MockVimTextArea };
});

let originalRequestAnimationFrame: typeof requestAnimationFrame | undefined;
let originalCancelAnimationFrame: typeof cancelAnimationFrame | undefined;

describe("ChatInput draft images", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    // ChatInput uses requestAnimationFrame directly (not window.requestAnimationFrame).
    // Happy DOM doesn't always define it on the global, so we polyfill.
    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      return window.setTimeout(() => callback(Date.now()), 0);
    };
    globalThis.cancelAnimationFrame = (handle: number): void => {
      window.clearTimeout(handle);
    };
  });

  afterEach(() => {
    cleanup();

    if (originalRequestAnimationFrame) {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    } else {
      delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    }

    if (originalCancelAnimationFrame) {
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    } else {
      delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
    }

    originalRequestAnimationFrame = undefined;
    originalCancelAnimationFrame = undefined;

    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("restores persisted image draft and clears it on remove", async () => {
    const workspaceId = "ws-draft-images";
    const imagesKey = getInputImagesKey(workspaceId);

    window.localStorage.setItem(
      imagesKey,
      JSON.stringify([{ id: "img-1", url: "data:image/png;base64,AAA", mediaType: "image/png" }])
    );

    const { getByAltText, getByLabelText } = render(
      <ChatInput
        variant="workspace"
        workspaceId={workspaceId}
        onTruncateHistory={() => Promise.resolve()}
      />
    );

    const img = getByAltText("Attached image") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AAA");

    fireEvent.click(getByLabelText("Remove image"));

    await waitFor(() => {
      expect(window.localStorage.getItem(imagesKey)).toBeNull();
    });
  });
});
