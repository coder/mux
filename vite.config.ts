import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import topLevelAwait from "vite-plugin-top-level-await";
import svgr from "vite-plugin-svgr";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const disableMermaid = process.env.VITE_DISABLE_MERMAID === "1";

// Vite server configuration (for dev-server remote access)
const devServerHost = process.env.MUX_VITE_HOST ?? "127.0.0.1"; // Secure by default
const devServerPort = Number(process.env.MUX_VITE_PORT ?? "5173");

const devServerAllowedHosts = (() => {
  const raw = process.env.MUX_VITE_ALLOWED_HOSTS?.trim();
  if (raw) {
    if (raw === "true" || raw === "all") {
      return true;
    }

    const parsed = raw
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean);

    return parsed.length ? parsed : ["localhost", "127.0.0.1"];
  }

  // Default to localhost-only. For remote access, set MUX_VITE_ALLOWED_HOSTS (or
  // the Makefile's VITE_ALLOWED_HOSTS).
  const defaults = ["localhost", "127.0.0.1"];

  // If the dev server is bound to a specific host (not a wildcard), include it so
  // access works without extra configuration.
  if (
    devServerHost !== "127.0.0.1" &&
    devServerHost !== "localhost" &&
    devServerHost !== "0.0.0.0" &&
    devServerHost !== "::"
  ) {
    defaults.push(devServerHost);
  }

  return defaults;
})();

const previewPort = Number(process.env.MUX_VITE_PREVIEW_PORT ?? "4173");

function formatHostForUrl(host: string): string {
  const trimmed = host.trim();
  const unbracketed =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;

  // IPv6 URLs must be bracketed: http://[::1]:1234
  if (unbracketed.includes(":")) {
    // If the host contains a zone index (e.g. fe80::1%en0), percent must be encoded.
    // Encode zone indices (including numeric ones like %12) while avoiding double-encoding
    // if the user already provided a URL-safe %25.
    const escaped = unbracketed.replace(/%(?!25)/gi, "%25");
    return `[${escaped}]`;
  }

  return unbracketed;
}

// In dev-server mode we run the backend on a separate local port, but we want the
// browser UI to talk to it via same-origin paths (single public port).
const backendProxyHost = process.env.MUX_BACKEND_HOST ?? "127.0.0.1";
const backendProxyPort = Number(process.env.MUX_BACKEND_PORT ?? "3000");
const backendProxyTarget = `http://${formatHostForUrl(backendProxyHost)}:${backendProxyPort}`;

const alias: Record<string, string> = {
  "@": path.resolve(__dirname, "./src"),
};

if (disableMermaid) {
  alias["mermaid"] = path.resolve(__dirname, "./src/mocks/mermaidStub.ts");
}

// React Compiler configuration
// Automatically optimizes React components through memoization
// See: https://react.dev/learn/react-compiler
const reactCompilerConfig = {
  target: "18", // Target React 18 (requires react-compiler-runtime package)
};

// Babel plugins configuration (shared between dev and production)
const babelPlugins = [["babel-plugin-react-compiler", reactCompilerConfig]];

// Base plugins for both dev and production
const basePlugins = [
  svgr(),
  react({
    babel: {
      plugins: babelPlugins,
    },
  }),
  tailwindcss(),
];

export default defineConfig(({ mode }) => ({
  // This prevents mermaid initialization errors in production while allowing dev to work
  plugins: mode === "development" ? [...basePlugins, topLevelAwait()] : basePlugins,
  resolve: {
    alias,
  },
  base: "./",
  build: {
    outDir: "dist",
    assetsDir: ".",
    emptyOutDir: false,
    sourcemap: true,
    minify: "esbuild",
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        terminal: path.resolve(__dirname, "terminal.html"),
      },
      output: {
        format: "es",
        inlineDynamicImports: false,
        sourcemapExcludeSources: false,
        manualChunks(id) {
          const normalizedId = id.split(path.sep).join("/");
          if (normalizedId.includes("node_modules/ai-tokenizer/encoding/")) {
            const chunkName = path.basename(id, path.extname(id));
            return `tokenizer-encoding-${chunkName}`;
          }
          if (normalizedId.includes("node_modules/ai-tokenizer/")) {
            return "tokenizer-base";
          }
          return undefined;
        },
      },
    },
    chunkSizeWarningLimit: 2000,
    target: "esnext",
  },
  worker: {
    format: "es",
    plugins: () => [topLevelAwait()],
  },
  server: {
    host: devServerHost, // Configurable via MUX_VITE_HOST (defaults to 127.0.0.1 for security)
    port: devServerPort,
    strictPort: true,
    allowedHosts: devServerAllowedHosts,

    proxy: {
      "/orpc": {
        target: backendProxyTarget,
        changeOrigin: true,
        ws: true,
      },
      "/api": {
        target: backendProxyTarget,
        changeOrigin: true,
      },
      "/auth": {
        target: backendProxyTarget,
        // Preserve the original Host so mux can generate OAuth redirect URLs that
        // point back to the public dev-server origin (not 127.0.0.1:3000).
        changeOrigin: false,
      },
      "/health": {
        target: backendProxyTarget,
        changeOrigin: true,
      },
      "/version": {
        target: backendProxyTarget,
        changeOrigin: true,
      },
    },
    sourcemapIgnoreList: () => false, // Show all sources in DevTools

    watch: {
      // Ignore node_modules to drastically reduce file handle usage
      ignored: ["**/node_modules/**", "**/dist/**", "**/.git/**"],

      // Use polling on Windows to avoid file handle exhaustion
      // This is slightly less efficient but much more stable
      usePolling: process.platform === "win32",

      // If using polling, set a reasonable interval (in milliseconds)
      interval: 1000,

      // Additional options for Windows specifically
      ...(process.platform === "win32" && {
        // Increase the binary interval for better Windows performance
        binaryInterval: 1000,
        // Use a more conservative approach to watching
        awaitWriteFinish: {
          stabilityThreshold: 500,
          pollInterval: 100,
        },
      }),
    },

    // Note: leave `server.hmr` unset so Vite derives the websocket URL from the
    // served script URL (works when accessed via reverse proxy / custom domain).
  },
  preview: {
    host: "127.0.0.1",
    port: previewPort,
    strictPort: true,
    allowedHosts: ["localhost", "127.0.0.1"],
  },
  optimizeDeps: {
    esbuildOptions: {
      target: "esnext",
    },

    // Limit dependency pre-bundling scans to the renderer entrypoints.
    // Scanning all of src/ includes backend-only code (src/node, src/cli), which can
    // pull in Node-only deps and break Vite's dep-scan (notably on Windows).
    entries: ["index.html", "terminal.html"],

    // Force re-optimize dependencies
    force: false,
  },
  assetsInclude: ["**/*.wasm"],
}));
