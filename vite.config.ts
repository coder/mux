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
const previewPort = Number(process.env.MUX_VITE_PREVIEW_PORT ?? "4173");

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
    allowedHosts: true, // Allow all hosts for dev server (secure by default via MUX_VITE_HOST)
    sourcemapIgnoreList: () => false, // Show all sources in DevTools
    
    watch: {
      // Ignore node_modules to drastically reduce file handle usage
      ignored: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
      
      // Use polling on Windows to avoid file handle exhaustion
      // This is slightly less efficient but much more stable
      usePolling: process.platform === 'win32',
      
      // If using polling, set a reasonable interval (in milliseconds)
      interval: 1000,
      
      // Limit the depth of directory traversal
      depth: 3,
      
      // Additional options for Windows specifically
      ...(process.platform === 'win32' && {
        // Increase the binary interval for better Windows performance
        binaryInterval: 1000,
        // Use a more conservative approach to watching
        awaitWriteFinish: {
          stabilityThreshold: 500,
          pollInterval: 100
        }
      })
    },
    
    hmr: {
      // Configure HMR to use the correct host for remote access
      host: devServerHost,
      port: devServerPort,
      protocol: "ws",
    },
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
    
    // Include only what's actually imported to reduce scanning
    entries: ['src/**/*.{ts,tsx}'],
    
    // Force re-optimize dependencies
    force: false,
  },
  assetsInclude: ["**/*.wasm"],
}));
