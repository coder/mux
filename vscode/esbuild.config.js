const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const tailwind = require("@tailwindcss/node");
const { Scanner } = require("@tailwindcss/oxide");

const isWatch = process.argv.includes("--watch");

function resolveMuxImport(subpath) {
  const base = path.resolve(__dirname, "..", "src", subpath);

  // Prefer explicit source extensions.
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.json`,
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Support directory imports (e.g. mux/foo -> src/foo/index.tsx).
  const indexCandidates = [
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.js"),
    path.join(base, "index.jsx"),
    path.join(base, "index.json"),
  ];

  for (const candidate of indexCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

// Plugin to resolve mux/* imports from parent directory.
const muxResolverPlugin = {
  name: "mux-resolver",
  setup(build) {
    build.onResolve({ filter: /^mux\// }, (args) => {
      const subpath = args.path.replace(/^mux\//, "");
      const resolved = resolveMuxImport(subpath);
      if (!resolved) {
        return null;
      }

      return { path: resolved };
    });
  },
};

// Build Tailwind CSS for the webview.
function ensureOutDir() {
  fs.mkdirSync(path.resolve(__dirname, "out"), { recursive: true });
}

let webviewCssBuildPromise = null;


function copySetiFont() {
  const src = path.resolve(__dirname, "..", "public", "seti.woff");
  const dest = path.resolve(__dirname, "out", "seti.woff");

  if (!fs.existsSync(src)) {
    throw new Error(`Missing Seti icon font at ${src}`);
  }

  ensureOutDir();
  fs.copyFileSync(src, dest);
}
function copyKatexAssets() {
  const katexCssPath = require.resolve("katex/dist/katex.min.css", {
    paths: [path.resolve(__dirname, "..")],
  });

  const katexDistDir = path.dirname(katexCssPath);
  const katexFontsDir = path.join(katexDistDir, "fonts");

  const outKatexDir = path.resolve(__dirname, "out", "katex");
  const outFontsDir = path.join(outKatexDir, "fonts");

  fs.mkdirSync(outFontsDir, { recursive: true });
  fs.copyFileSync(katexCssPath, path.join(outKatexDir, "katex.min.css"));

  for (const entry of fs.readdirSync(katexFontsDir)) {
    const src = path.join(katexFontsDir, entry);
    const dest = path.join(outFontsDir, entry);

    if (!fs.statSync(src).isFile()) {
      continue;
    }

    fs.copyFileSync(src, dest);
  }
}



function buildWebviewCss() {
  if (webviewCssBuildPromise) {
    return webviewCssBuildPromise;
  }

  webviewCssBuildPromise = (async () => {
    ensureOutDir();

    const inputPath = path.resolve(__dirname, "src", "webview", "webview.css");
    const outputPath = path.resolve(__dirname, "out", "muxChatView.css");
    const input = fs.readFileSync(inputPath, "utf8");

    const compiled = await tailwind.compile(input, {
      base: path.dirname(inputPath),
      from: inputPath,
      onDependency: () => undefined,
    });

    const scanner = new Scanner({ sources: compiled.sources });
    const candidates = scanner.scan();

    const built = compiled.build(candidates);
    const optimized = tailwind.optimize(built, { minify: true }).code;

    fs.writeFileSync(outputPath, optimized);
  })().finally(() => {
    webviewCssBuildPromise = null;
  });

  return webviewCssBuildPromise;
}

function watchWebviewCss() {
  const inputPath = path.resolve(__dirname, "src", "webview", "webview.css");
  let timeout = null;

  fs.watch(inputPath, { persistent: true }, () => {
    if (timeout) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(() => {
      void buildWebviewCss();
    }, 25);
  });
}

// Stub Vite-style SVG React imports ("*.svg?react") used by mux UI.
const stubSvgReactPlugin = {
  name: "stub-svg-react",
  setup(build) {
    build.onResolve({ filter: /\.svg\?react$/ }, () => {
      return { path: "svg-react-stub", namespace: "stub-svg-react" };
    });

    build.onLoad({ filter: /.*/, namespace: "stub-svg-react" }, () => {
      return {
        contents: "export default function SvgReactStub() { return null; }",
        loader: "js",
      };
    });
  },
};

// Ensure Tailwind CSS rebuilds when the webview bundle rebuilds.
const rebuildWebviewCssPlugin = {
  name: "rebuild-webview-css",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors && result.errors.length > 0) {
        return;
      }

      void buildWebviewCss();
    });
  },
};

// The mux markdown renderer imports KaTeX CSS.
// In the VS Code webview we ship a single Tailwind-derived stylesheet instead.
const stubKatexCssPlugin = {
  name: "stub-katex-css",
  setup(build) {
    build.onResolve({ filter: /^katex\/dist\/katex\.min\.css$/ }, () => {
      return { path: "katex.min.css", namespace: "stub-css" };
    });

    build.onLoad({ filter: /.*/, namespace: "stub-css" }, () => {
      return { contents: "", loader: "js" };
    });
  },
};

const sharedConfig = {
  plugins: [muxResolverPlugin],
  alias: {
    "@": path.resolve(__dirname, "../src"),
  },
  nodePaths: [path.resolve(__dirname, "../node_modules")],
  mainFields: ["module", "main"],
  sourcemap: true,
};

const extensionBuild = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outdir: "out",
  external: ["vscode"],
  platform: "node",
  target: "node20",
  format: "cjs",
  minify: true,
  ...sharedConfig,
};

const webviewBuild = {
  entryPoints: {
    muxChatView: "src/webview/index.tsx",
  },
  bundle: true,
  outdir: "out",
  platform: "browser",
  jsx: "automatic",
  format: "esm",
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  target: "es2020",
  minify: true,
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  ...sharedConfig,
  plugins: [
    ...sharedConfig.plugins,
    stubSvgReactPlugin,
    stubKatexCssPlugin,
    ...(isWatch ? [rebuildWebviewCssPlugin] : []),
  ],
};

async function main() {
  copyKatexAssets();
  copySetiFont();

  if (isWatch) {
    await buildWebviewCss();
    watchWebviewCss();

    const ext = await esbuild.context(extensionBuild);
    const web = await esbuild.context(webviewBuild);

    await Promise.all([ext.watch(), web.watch()]);

    // Keep process alive.
    // eslint-disable-next-line no-console
    console.log("mux VS Code extension: watching for changes...");
    return;
  }

  await Promise.all([
    buildWebviewCss(),
    esbuild.build(extensionBuild),
    esbuild.build(webviewBuild),
  ]);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
