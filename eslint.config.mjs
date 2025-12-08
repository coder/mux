// For more info, see https://github.com/storybookjs/eslint-plugin-storybook#configuration-flat-config-format
import storybook from "eslint-plugin-storybook";

import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import tailwindcss from "eslint-plugin-tailwindcss";
import tseslint from "typescript-eslint";

/**
 * Custom ESLint plugin for safe Node.js patterns
 * Enforces safe child_process and filesystem patterns
 */
const localPlugin = {
  rules: {
    "no-unsafe-child-process": {
      meta: {
        type: "problem",
        docs: {
          description: "Prevent unsafe child_process usage that can cause zombie processes",
        },
        messages: {
          unsafePromisifyExec:
            "Do not use promisify(exec) directly. Use DisposableExec wrapper with 'using' declaration to prevent zombie processes.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            // Ban promisify(exec)
            if (
              node.callee.type === "Identifier" &&
              node.callee.name === "promisify" &&
              node.arguments.length > 0 &&
              node.arguments[0].type === "Identifier" &&
              node.arguments[0].name === "exec"
            ) {
              context.report({
                node,
                messageId: "unsafePromisifyExec",
              });
            }
          },
        };
      },
    },
    "no-sync-fs-methods": {
      meta: {
        type: "problem",
        docs: {
          description: "Prevent synchronous filesystem operations",
        },
        messages: {
          syncFsMethod:
            "Do not use synchronous fs methods ({{method}}). Use async version instead: {{asyncMethod}}",
        },
      },
      create(context) {
        // Map of sync methods to their async equivalents
        const syncMethods = {
          statSync: "stat",
          readFileSync: "readFile",
          writeFileSync: "writeFile",
          readdirSync: "readdir",
          mkdirSync: "mkdir",
          unlinkSync: "unlink",
          rmdirSync: "rmdir",
          existsSync: "access or stat",
          accessSync: "access",
          copyFileSync: "copyFile",
          renameSync: "rename",
          chmodSync: "chmod",
          chownSync: "chown",
          lstatSync: "lstat",
          linkSync: "link",
          symlinkSync: "symlink",
          readlinkSync: "readlink",
          realpathSync: "realpath",
          truncateSync: "truncate",
          fstatSync: "fstat",
          appendFileSync: "appendFile",
        };

        return {
          MemberExpression(node) {
            // Only flag if it's a property access on 'fs' or imported fs methods
            if (
              node.property &&
              node.property.type === "Identifier" &&
              syncMethods[node.property.name] &&
              node.object &&
              node.object.type === "Identifier" &&
              (node.object.name === "fs" || node.object.name === "fsPromises")
            ) {
              context.report({
                node,
                messageId: "syncFsMethod",
                data: {
                  method: node.property.name,
                  asyncMethod: syncMethods[node.property.name],
                },
              });
            }
          },
        };
      },
    },
    "no-cross-boundary-imports": {
      meta: {
        type: "problem",
        docs: {
          description: "Enforce folder boundaries to prevent architectural violations",
        },
        messages: {
          browserToNode:
            "browser/ cannot import from node/. Move shared code to common/ or use IPC.",
          nodeToDesktop:
            "node/ cannot import from desktop/. Move shared code to common/ or use dependency injection.",
          nodeToCli: "node/ cannot import from cli/. Move shared code to common/.",
          cliToBrowser: "cli/ cannot import from browser/. Move shared code to common/.",
          desktopToBrowser: "desktop/ cannot import from browser/. Move shared code to common/.",
        },
      },
      create(context) {
        return {
          ImportDeclaration(node) {
            // Allow type-only imports (for DI patterns)
            if (node.importKind === "type") {
              return;
            }

            const sourceFile = context.filename;
            const importPath = node.source.value;

            // Extract folder from source file (browser, node, desktop, cli, common)
            const sourceFolderMatch = sourceFile.match(
              /\/src\/(browser|node|desktop|cli|common)\//
            );
            if (!sourceFolderMatch) return;
            const sourceFolder = sourceFolderMatch[1];

            // Extract folder from import target
            // Handle relative imports (e.g., '../node/...')
            let targetFolder = null;
            if (importPath.startsWith("../")) {
              const targetMatch = importPath.match(/\.\.\/(browser|node|desktop|cli|common)\//);
              if (targetMatch) {
                targetFolder = targetMatch[1];
              }
            } else if (importPath.startsWith("@/")) {
              // Handle alias imports (e.g., '@/node/...')
              const targetMatch = importPath.match(/@\/(browser|node|desktop|cli|common)\//);
              if (targetMatch) {
                targetFolder = targetMatch[1];
              }
            }

            if (!targetFolder) return;

            // Allow imports from common
            if (targetFolder === "common") return;

            // Check for violations
            if (sourceFolder === "browser" && targetFolder === "node") {
              context.report({
                node,
                messageId: "browserToNode",
              });
            } else if (sourceFolder === "node" && targetFolder === "desktop") {
              context.report({
                node,
                messageId: "nodeToDesktop",
              });
            } else if (sourceFolder === "node" && targetFolder === "cli") {
              context.report({
                node,
                messageId: "nodeToCli",
              });
            } else if (sourceFolder === "cli" && targetFolder === "browser") {
              context.report({
                node,
                messageId: "cliToBrowser",
              });
            } else if (sourceFolder === "desktop" && targetFolder === "browser") {
              context.report({
                node,
                messageId: "desktopToBrowser",
              });
            }
          },
        };
      },
    },
  },
};

export default defineConfig([
  {
    ignores: [
      "dist/",
      "build/",
      "node_modules/",
      "*.js",
      "*.cjs",
      "*.mjs",
      "!eslint.config.mjs",
      "vite.config.ts",
      "electron.vite.config.ts",
      "src/browser/main.tsx",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.main.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        exports: "writable",
        module: "writable",
        require: "readonly",
        global: "readonly",
        window: "readonly",
        document: "readonly",
        requestAnimationFrame: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        navigator: "readonly",
        alert: "readonly",
      },
    },
    plugins: {
      react,
      "react-hooks": reactHooks,
      tailwindcss,
      local: localPlugin,
    },
    settings: {
      react: {
        version: "detect",
      },
      tailwindcss: {
        // Don't try to load Tailwind config (v4 doesn't export resolveConfig)
        config: false,
        // CSS files to check
        cssFiles: ["**/*.css", "!**/node_modules", "!**/.*", "!**/dist", "!**/build"],
        // Disable callees check to avoid resolving config
        callees: [],
      },
    },
    rules: {
      ...react.configs.recommended.rules,
      // Use recommended-latest to get React Compiler lint rules
      ...reactHooks.configs["recommended-latest"].rules,

      // Flag unused variables, parameters, and imports
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          vars: "all",
          args: "after-used",
          ignoreRestSiblings: true,
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "all",
        },
      ],

      // Prohibit 'as any' type assertions
      "@typescript-eslint/no-explicit-any": "error",

      // Additional rule to catch 'as any' specifically
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        {
          assertionStyle: "as",
          objectLiteralTypeAssertions: "allow-as-parameter",
        },
      ],

      // Enforce shorthand array notation, e.g. Foo[] instead of Array<Foo>
      "@typescript-eslint/array-type": [
        "error",
        {
          default: "array-simple",
          readonly: "array-simple",
        },
      ],

      // Keep type-only imports explicit to avoid runtime inclusion
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          disallowTypeAnnotations: true,
        },
      ],

      // Require handling Promises instead of letting them float
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          ignoreVoid: true,
          ignoreIIFE: true,
        },
      ],

      // Highlight unnecessary assertions to keep code idiomatic
      "@typescript-eslint/no-unnecessary-type-assertion": "error",

      // Encourage readonly where possible to surface unintended mutations
      "@typescript-eslint/prefer-readonly": [
        "error",
        {
          onlyInlineLambdas: true,
        },
      ],

      // Prevent using any type at all
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",

      // React specific
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",

      // Tailwind CSS
      "tailwindcss/classnames-order": "warn",
      "tailwindcss/enforces-negative-arbitrary-values": "warn",
      "tailwindcss/enforces-shorthand": "warn",
      "tailwindcss/migration-from-tailwind-2": "warn",
      "tailwindcss/no-arbitrary-value": "off",
      "tailwindcss/no-contradicting-classname": "error",
      "tailwindcss/no-custom-classname": "off",

      // Safe Node.js patterns
      "local/no-unsafe-child-process": "error",
      "local/no-sync-fs-methods": "error",
      "local/no-cross-boundary-imports": "error",

      // Allow console for this app (it's a dev tool)
      "no-console": "off",

      // Allow require in specific contexts
      "@typescript-eslint/no-var-requires": "off",

      // Enforce absolute imports with @/ alias for cross-directory imports
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../!(tests)*", "../../!(tests)*"],
              message:
                "Use absolute imports with @/ instead of relative parent imports. Same-directory imports (./foo) are allowed.",
            },
          ],
        },
      ],

      // Warn on TODO comments
      "no-warning-comments": [
        "off",
        {
          terms: ["TODO", "FIXME", "XXX", "HACK"],
          location: "start",
        },
      ],

      // Enable TypeScript deprecation warnings
      "@typescript-eslint/prefer-ts-expect-error": "error",

      // Ban @ts-ignore comments and suggest @ts-expect-error instead
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": "allow-with-description",
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-check": false,
          minimumDescriptionLength: 3,
        },
      ],

      // Ban dynamic imports - they hide circular dependencies and should be avoided
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message:
            "Dynamic imports are not allowed. Use static imports at the top of the file instead. Dynamic imports hide circular dependencies and improper module structure.",
        },
      ],

      // Prevent accidentally interpolating undefined/null in template literals and JSX
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        {
          allowNumber: true,
          allowBoolean: true,
          allowAny: false,
          allowNullish: false, // Catch undefined/null interpolations
          allowRegExp: false,
        },
      ],
    },
  },
  {
    // Allow dynamic imports for lazy-loading AI SDK packages (startup optimization)
    files: [
      "src/services/aiService.ts",
      "src/utils/tools/tools.ts",
      "src/utils/ai/providerFactory.ts",
      "src/utils/main/tokenizer.ts",
    ],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
  {
    // Temporarily allow sync fs methods in files with existing usage
    // TODO: Gradually migrate these to async operations
    files: [
      "src/node/config.ts",
      "src/cli/debug/**/*.ts",
      "src/node/git.ts",
      "src/desktop/main.ts",
      "src/node/config.test.ts",
      "src/node/services/gitService.ts",
      "src/node/services/log.ts",
      "src/node/services/streamManager.ts",
      "src/node/services/tempDir.ts",
      "src/node/services/tools/bash.ts",
      "src/node/services/tools/bash.test.ts",
      "src/node/services/tools/testHelpers.ts",
    ],
    rules: {
      "local/no-sync-fs-methods": "off",
    },
  },
  {
    // Frontend architectural boundary - prevent services and tokenizer imports
    // Note: src/browser/utils/** and src/browser/stores/** are not included because:
    // - Some utils are shared between main/renderer (e.g., utils/tools registry)
    // - Stores can import from utils/messages which is renderer-safe
    // - Type-only imports from services are safe (types live in src/common/types/)
    files: [
      "src/browser/components/**",
      "src/browser/contexts/**",
      "src/browser/hooks/**",
      "src/browser/App.tsx",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/services/**", "../services/**", "../../services/**"],
              message:
                "Frontend code cannot import from services/. Use IPC or move shared code to utils/.",
            },
            {
              group: ["**/tokens/tokenizer", "**/tokens/tokenStatsCalculator"],
              message:
                "Frontend code cannot import tokenizer (2MB+ encodings). Use @/utils/tokens/usageAggregator for aggregation or @/utils/tokens/modelStats for pricing.",
            },
            {
              group: ["**/utils/main/**", "@/utils/main/**"],
              message:
                "Frontend code cannot import from utils/main/ (contains Node.js APIs). Move shared code to utils/ or use IPC.",
            },
          ],
        },
      ],
    },
  },
  {
    // Shiki must only be imported in the highlight worker to avoid blocking main thread
    // Type-only imports are allowed (erased at compile time)
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["src/browser/workers/highlightWorker.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["shiki"],
              importNamePattern: "^(?!type\\s)",
              allowTypeImports: true,
              message:
                "Shiki must only be imported in highlightWorker.ts to avoid blocking the main thread. Use highlightCode() from highlightWorkerClient.ts instead.",
            },
          ],
        },
      ],
    },
  },
  {
    // Renderer process (frontend) architectural boundary - prevent Node.js API usage
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: [
      "src/cli/**",
      "src/desktop/**",
      "src/node/**",
      "**/*.test.ts",
      "**/*.test.tsx",
      // This file is only used by Node.js code (cli/debug) but lives in common/
      // TODO: Consider moving to node/utils/
      "src/common/utils/providers/ensureProvidersConfig.ts",
      // Telemetry uses defensive process checks for test environments
      "src/common/telemetry/**",
    ],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "process",
          message:
            "Renderer code cannot access 'process' global (not available in renderer). Use IPC to communicate with main process or use constants for environment-agnostic values.",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message:
            "Renderer code cannot access process.env (not available in renderer). Use IPC to get environment variables from main process or use constants.",
        },
      ],
    },
  },
  {
    // Test file configuration
    files: ["**/*.test.ts", "**/*.test.tsx"],
    languageOptions: {
      globals: {
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        expect: "readonly",
        jest: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
      },
    },
  },
  {
    // Storybook story files - disable type-aware rules for Storybook 10 barrel exports
    files: ["**/*.stories.ts", "**/*.stories.tsx", ".storybook/**/*.ts", ".storybook/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  ...storybook.configs["flat/recommended"],
]);
