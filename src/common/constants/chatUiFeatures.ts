export const CHAT_UI_FEATURE_IDS = [
  "messageEditing",
  "imageAttachments",
  "slashCommandSuggestions",
  "commandPalette",
  "voiceInput",
  "reviewAnnotations",
  "bashForegroundControls",
  "jsonRawView",
] as const;

export type ChatUiFeatureId = (typeof CHAT_UI_FEATURE_IDS)[number];

export type ChatUiSupport = "supported" | "unsupported" | "planned";
