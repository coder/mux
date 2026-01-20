/**
 * FileViewer stories - testing file viewer pane with text and image files
 *
 * Uses wide viewport (1600px) to ensure RightSidebar tabs are visible.
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import {
  setupSimpleChatStory,
  expandRightSidebar,
  setReviews,
  createReview,
  type SimpleChatSetupOptions,
} from "./storyHelpers";
import { createUserMessage, createAssistantMessage } from "./mockFactory";
import { within } from "@storybook/test";
import { blurActiveElement } from "./storyPlayHelpers.js";
import { RIGHT_SIDEBAR_WIDTH_KEY, getRightSidebarLayoutKey } from "@/common/constants/storage";
import type { ComponentType } from "react";

/** File content type for mocking */
type FileContent =
  | { type: "text"; content: string }
  | { type: "image"; base64: string }
  | { type: "binary" }
  | { type: "too-large" };

/**
 * Creates an executeBash mock that handles file read and diff scripts.
 * Parses the script to determine which file is being requested.
 */
function createFileViewerExecuteBash(
  fileContents: Map<string, FileContent>,
  fileDiffs?: Map<string, string>
): NonNullable<SimpleChatSetupOptions["executeBash"]> {
  return (_workspaceId: string, script: string) => {
    const bashResult = (output: string, exitCode = 0) =>
      Promise.resolve({
        success: true as const,
        output,
        exitCode,
        wall_duration_ms: 1,
      });

    // Check if this is a file read script (contains "base64")
    if (script.includes("base64")) {
      // Extract file path from script - pattern: base64 < 'path'
      const match = /base64\s+<\s+'([^']+)'/.exec(script);
      if (match) {
        const filePath = match[1];
        const content = fileContents.get(filePath);
        if (content) {
          if (content.type === "text") {
            // Use TextEncoder for proper UTF-8 handling (btoa can't handle Unicode)
            const bytes = new TextEncoder().encode(content.content);
            const base64 = btoa(String.fromCharCode(...bytes));
            const size = bytes.length;
            return bashResult(`${size}\n${base64}`);
          } else if (content.type === "image") {
            // For images, we have base64 already
            const size = Math.ceil(content.base64.length * 0.75); // Approximate decoded size
            return bashResult(`${size}\n${content.base64}`);
          } else if (content.type === "binary") {
            // Binary - return null byte
            return bashResult(`10\n${btoa("\0binary")}`);
          } else {
            // Too large - exit with code 42
            return bashResult("", 42);
          }
        }
        return bashResult(`No such file: ${filePath}`, 1);
      }
    }

    // Check if this is a git diff script
    if (script.includes("git diff")) {
      // Extract file path from script - pattern: git diff -- 'path'
      const match = /git\s+diff\s+--\s+'([^']+)'/.exec(script);
      if (match) {
        const filePath = match[1];
        const diff = fileDiffs?.get(filePath) ?? "";
        return bashResult(diff);
      }
    }

    // Default: empty output
    return bashResult("");
  };
}

export default {
  ...appMeta,
  title: "App/FileViewer",
  decorators: [
    (Story: ComponentType) => (
      <div style={{ width: 1600, height: "100dvh" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...appMeta.parameters,
    chromatic: {
      ...(appMeta.parameters?.chromatic ?? {}),
      modes: {
        dark: { theme: "dark", viewport: 1600 },
        light: { theme: "light", viewport: 1600 },
      },
    },
  },
};

/**
 * Generate a 256x256 PNG with a red square (128x128) centered on transparent background.
 * Uses canvas API to create the image at runtime for story setup.
 */
function generateTestPng(): string {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;

  // Transparent background (default)
  ctx.clearRect(0, 0, 256, 256);

  // Red square in the center (128x128, offset by 64px from edges)
  ctx.fillStyle = "#ef4444";
  ctx.fillRect(64, 64, 128, 128);

  // Return base64 without the data URL prefix
  return canvas.toDataURL("image/png").replace("data:image/png;base64,", "");
}

// Sample TypeScript file content (short version for non-diff story)
const SAMPLE_TS_CONTENT = [
  'import { useState } from "react";',
  "",
  "interface ButtonProps {",
  "  label: string;",
  "  onClick: () => void;",
  '  variant?: "primary" | "secondary";',
  "}",
  "",
  "export function Button(props: ButtonProps) {",
  "  const [isHovered, setIsHovered] = useState(false);",
  "",
  "  return (",
  "    <button",
  '      className={`btn btn-${props.variant ?? "primary"}`}',
  "      onClick={props.onClick}",
  "      onMouseEnter={() => setIsHovered(true)}",
  "      onMouseLeave={() => setIsHovered(false)}",
  "    >",
  "      {props.label}",
  "    </button>",
  "  );",
  "}",
].join("\n");

// Longer sample content for diff story (NEW version - matches SAMPLE_DIFF's new side)
const SAMPLE_TS_CONTENT_LONG = `import { useState, useCallback, useMemo } from "react";
import { cn } from "@/utils/cn";

/** Button variant styles */
const VARIANTS = {
  primary: "bg-blue-500 hover:bg-blue-600 text-white",
  secondary: "bg-gray-200 hover:bg-gray-300 text-gray-800",
  danger: "bg-red-500 hover:bg-red-600 text-white",
} as const;

/** Button size styles */
const SIZES = {
  sm: "px-2 py-1 text-sm",
  md: "px-4 py-2 text-base",
  lg: "px-6 py-3 text-lg",
} as const;

interface ButtonProps {
  /** Button label text */
  label: string;
  /** Click handler */
  onClick: () => void;
  /** Visual style variant */
  variant?: "primary" | "secondary" | "danger";
  /** Size preset */
  size?: "sm" | "md" | "lg";
  /** Disabled state */
  disabled?: boolean;
  /** Loading state - shows spinner */
  loading?: boolean;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Reusable button component with multiple variants and sizes.
 * Supports loading and disabled states.
 */
export function Button(props: ButtonProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isPressed, setIsPressed] = useState(false);

  const handleMouseEnter = useCallback(() => {
    if (!props.disabled) setIsHovered(true);
  }, [props.disabled]);

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
    setIsPressed(false);
  }, []);

  const handleMouseDown = useCallback(() => {
    if (!props.disabled) setIsPressed(true);
  }, [props.disabled]);

  const handleMouseUp = useCallback(() => {
    setIsPressed(false);
  }, []);

  const variantClass = VARIANTS[props.variant ?? "primary"];
  const sizeClass = SIZES[props.size ?? "md"];

  const buttonClass = useMemo(
    () =>
      cn(
        "rounded font-medium transition-all duration-150",
        "focus:outline-none focus:ring-2 focus:ring-offset-2",
        variantClass,
        sizeClass,
        props.disabled && "opacity-50 cursor-not-allowed",
        isPressed && "scale-95",
        props.className
      ),
    [variantClass, sizeClass, props.disabled, isPressed, props.className]
  );

  return (
    <button
      type="button"
      className={buttonClass}
      onClick={props.onClick}
      disabled={props.disabled || props.loading}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
    >
      {props.loading && (
        <span className="inline-block animate-spin mr-2">⟳</span>
      )}
      {props.label}
    </button>
  );
}`;

// Valid unified diff generated by `diff -u` - transforms old -> new (SAMPLE_TS_CONTENT_LONG)
const SAMPLE_DIFF = `--- /tmp/Button.old.tsx	2026-01-15 05:00:17.950815972 +0000
+++ /tmp/Button.new.tsx	2026-01-15 05:00:17.950815972 +0000
@@ -1,4 +1,4 @@
-import { useState, useCallback } from "react";
+import { useState, useCallback, useMemo } from "react";
 import { cn } from "@/utils/cn";
 
 /** Button variant styles */
@@ -22,20 +22,23 @@
   onClick: () => void;
   /** Visual style variant */
   variant?: "primary" | "secondary" | "danger";
+  /** Size preset */
+  size?: "sm" | "md" | "lg";
   /** Disabled state */
   disabled?: boolean;
-  /** Show loading indicator */
-  isLoading?: boolean;
+  /** Loading state - shows spinner */
+  loading?: boolean;
   /** Additional CSS classes */
   className?: string;
 }
 
 /**
- * Reusable button component with multiple variants.
+ * Reusable button component with multiple variants and sizes.
  * Supports loading and disabled states.
  */
 export function Button(props: ButtonProps) {
   const [isHovered, setIsHovered] = useState(false);
+  const [isPressed, setIsPressed] = useState(false);
 
   const handleMouseEnter = useCallback(() => {
     if (!props.disabled) setIsHovered(true);
@@ -43,15 +46,32 @@
 
   const handleMouseLeave = useCallback(() => {
     setIsHovered(false);
+    setIsPressed(false);
+  }, []);
+
+  const handleMouseDown = useCallback(() => {
+    if (!props.disabled) setIsPressed(true);
+  }, [props.disabled]);
+
+  const handleMouseUp = useCallback(() => {
+    setIsPressed(false);
   }, []);
 
   const variantClass = VARIANTS[props.variant ?? "primary"];
-  const sizeClass = SIZES["md"];
+  const sizeClass = SIZES[props.size ?? "md"];
 
-  const buttonClass = cn(
-    "rounded font-medium transition-colors",
-    variantClass,
-    props.disabled && "opacity-50 cursor-not-allowed"
+  const buttonClass = useMemo(
+    () =>
+      cn(
+        "rounded font-medium transition-all duration-150",
+        "focus:outline-none focus:ring-2 focus:ring-offset-2",
+        variantClass,
+        sizeClass,
+        props.disabled && "opacity-50 cursor-not-allowed",
+        isPressed && "scale-95",
+        props.className
+      ),
+    [variantClass, sizeClass, props.disabled, isPressed, props.className]
   );
 
   return (
@@ -59,11 +79,13 @@
       type="button"
       className={buttonClass}
       onClick={props.onClick}
-      disabled={props.disabled || props.isLoading}
+      disabled={props.disabled || props.loading}
       onMouseEnter={handleMouseEnter}
       onMouseLeave={handleMouseLeave}
+      onMouseDown={handleMouseDown}
+      onMouseUp={handleMouseUp}
     >
-      {props.isLoading && (
+      {props.loading && (
         <span className="inline-block animate-spin mr-2">⟳</span>
       )}
       {props.label}
`;

/**
 * Text file viewer showing TypeScript file with syntax highlighting
 */
// Helper to create a layout state with a file tab open
// Includes "stats" tab to prevent the stats feature flag effect from adding it and activating it
function createFileTabLayout(filePath: string) {
  const fileTab = `file:${filePath}`;
  return {
    version: 1,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: {
      type: "tabset",
      id: "tabset-1",
      tabs: ["costs", "review", "explorer", "stats", fileTab],
      activeTab: fileTab,
    },
  };
}

export const TextFileNoChanges: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-file-viewer-text";
        const filePath = "src/components/Button.tsx";
        localStorage.setItem(
          getRightSidebarLayoutKey(workspaceId),
          JSON.stringify(createFileTabLayout(filePath))
        );
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "500");

        const fileContents = new Map<string, FileContent>([
          ["src/components/Button.tsx", { type: "text", content: SAMPLE_TS_CONTENT }],
        ]);
        const client = setupSimpleChatStory({
          workspaceId,
          workspaceName: "feature/button",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Improve the button component", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Updated Button.tsx with hover state.", {
              historySequence: 2,
            }),
          ],
          executeBash: createFileViewerExecuteBash(fileContents),
        });
        expandRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for file tab to appear
    await canvas.findByRole("tab", { name: /Button\.tsx/i }, { timeout: 10000 });

    // Double-RAF for scroll stabilization
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    blurActiveElement();
  },
};

/**
 * Text file viewer with inline diff showing added and removed lines
 */
export const TextFileWithDiff: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-file-viewer-diff";
        const filePath = "src/components/Button.tsx";
        localStorage.setItem(
          getRightSidebarLayoutKey(workspaceId),
          JSON.stringify(createFileTabLayout(filePath))
        );

        const baseTime = 1700000000000;
        setReviews(workspaceId, [
          createReview(
            "review-range-1",
            filePath,
            "+1-4",
            "Double-check the updated imports.",
            "pending",
            baseTime
          ),
        ]);
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "600");

        const fileContents = new Map<string, FileContent>([
          ["src/components/Button.tsx", { type: "text", content: SAMPLE_TS_CONTENT_LONG }],
        ]);
        const fileDiffs = new Map([["src/components/Button.tsx", SAMPLE_DIFF]]);
        const client = setupSimpleChatStory({
          workspaceId,
          workspaceName: "feature/button-disabled",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Add disabled state to button", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Added disabled prop with spinner.", {
              historySequence: 2,
            }),
          ],
          executeBash: createFileViewerExecuteBash(fileContents, fileDiffs),
        });
        expandRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for file tab to appear
    await canvas.findByRole("tab", { name: /Button\.tsx/i }, { timeout: 10000 });

    // Double-RAF for scroll stabilization
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    blurActiveElement();
  },
};

/**
 * Image viewer showing a small image at 100% zoom
 */
export const ImageFile: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-file-viewer-image";
        const filePath = "assets/icon.png";
        localStorage.setItem(
          getRightSidebarLayoutKey(workspaceId),
          JSON.stringify(createFileTabLayout(filePath))
        );
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "500");

        const fileContents = new Map<string, FileContent>([
          ["assets/icon.png", { type: "image", base64: generateTestPng() }],
        ]);
        const client = setupSimpleChatStory({
          workspaceId,
          workspaceName: "feature/icons",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Add app icon", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Added icon.png.", {
              historySequence: 2,
            }),
          ],
          executeBash: createFileViewerExecuteBash(fileContents),
        });
        expandRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for file tab to appear
    await canvas.findByRole("tab", { name: /icon\.png/i }, { timeout: 10000 });

    // Double-RAF for scroll stabilization
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    blurActiveElement();
  },
};

/**
 * Binary file error - shows error message for non-text/non-image files
 */
export const BinaryFileError: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-file-viewer-binary";
        const filePath = "build/app.exe";
        localStorage.setItem(
          getRightSidebarLayoutKey(workspaceId),
          JSON.stringify(createFileTabLayout(filePath))
        );
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "500");

        const fileContents = new Map<string, FileContent>([["build/app.exe", { type: "binary" }]]);
        const client = setupSimpleChatStory({
          workspaceId,
          workspaceName: "feature/build",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Build the app", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Built app.exe successfully.", {
              historySequence: 2,
            }),
          ],
          executeBash: createFileViewerExecuteBash(fileContents),
        });
        expandRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for file tab to appear
    await canvas.findByRole("tab", { name: /app\.exe/i }, { timeout: 10000 });

    // Wait for error message
    await canvas.findByText(/unable to display binary file/i, {}, { timeout: 5000 });

    // Double-RAF for scroll stabilization
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    blurActiveElement();
  },
};

/**
 * Large file error - shows error message when file exceeds size limit
 */
export const LargeFileError: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-file-viewer-large";
        const filePath = "data/dump.sql";
        localStorage.setItem(
          getRightSidebarLayoutKey(workspaceId),
          JSON.stringify(createFileTabLayout(filePath))
        );
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "500");

        const fileContents = new Map<string, FileContent>([
          ["data/dump.sql", { type: "too-large" }],
        ]);
        const client = setupSimpleChatStory({
          workspaceId,
          workspaceName: "feature/db",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Export database", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Exported to dump.sql.", {
              historySequence: 2,
            }),
          ],
          executeBash: createFileViewerExecuteBash(fileContents),
        });
        expandRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for file tab to appear
    await canvas.findByRole("tab", { name: /dump\.sql/i }, { timeout: 10000 });

    // Wait for error message
    await canvas.findByText(/file is too large/i, {}, { timeout: 5000 });

    // Double-RAF for scroll stabilization
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    blurActiveElement();
  },
};
