# mux server Docker image
# Multi-stage build with esbuild bundling for minimal runtime image
#
# Build:   docker build -t mux-server .
# Run:     docker run -p 3000:3000 -v ~/.mux:/root/.mux mux-server
#
# See docker-compose.yml for easier orchestration

# ==============================================================================
# Stage 1: Build
# ==============================================================================
FROM node:22-slim AS builder

WORKDIR /app

# Install bun (used for package management and build tooling)
RUN npm install -g bun@1.2

# Install git (needed for version generation) and build tools for native modules
# bzip2 is required for lzma-native to extract its bundled xz source tarball
RUN apt-get update && apt-get install -y git python3 make g++ bzip2 && rm -rf /var/lib/apt/lists/*

# Copy package files first for better layer caching
COPY package.json bun.lock bunfig.toml ./

# Copy postinstall script (needed by bun install)
COPY scripts/postinstall.sh scripts/

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source files needed for build
COPY src/ src/
COPY tsconfig.json tsconfig.main.json ./
COPY scripts/generate-version.sh scripts/
COPY index.html terminal.html vite.config.ts ./
COPY public/ public/
COPY static/ static/

# Remove test files (they import from tests/ which is outside rootDir)
RUN find src -name '*.test.ts' -delete

# Initialize git for version script (uses placeholder if not a real repo)
RUN git init && \
    git config user.email "docker@build" && \
    git config user.name "Docker Build" && \
    git add -A && \
    git commit -m "docker build" --allow-empty || true

# Generate version info
RUN ./scripts/generate-version.sh

# Build main process (server + backend)
# Use tsgo (native TypeScript) for consistency with local build
RUN NODE_ENV=production bun run node_modules/@typescript/native-preview/bin/tsgo.js -p tsconfig.main.json && \
    NODE_ENV=production bun x tsc-alias -p tsconfig.main.json

# Build renderer (frontend)
RUN bun x vite build

# Bundle server with esbuild (reduces ~2GB node_modules to ~10MB bundle)
# External: native modules that can't be bundled
# Alias: use ESM version of jsonc-parser to avoid UMD bundling issues
RUN bun x esbuild dist/cli/server.js \
    --bundle \
    --platform=node \
    --target=node22 \
    --format=cjs \
    --outfile=dist/server-bundle.js \
    --external:@lydell/node-pty \
    --external:node-pty \
    --external:electron \
    --alias:jsonc-parser=jsonc-parser/lib/esm/main.js \
    --minify

# Copy static assets
RUN mkdir -p dist/static && cp -r static/* dist/static/ 2>/dev/null || true

# ==============================================================================
# Stage 2: Runtime
# ==============================================================================
FROM node:22-slim

WORKDIR /app

# Install runtime dependencies
# - git: required for workspace operations (clone, worktree, etc.)
# - openssh-client: required for SSH runtime support
RUN apt-get update && \
    apt-get install -y git openssh-client && \
    rm -rf /var/lib/apt/lists/*

# Copy bundled server and frontend assets
# Vite outputs JS/CSS/HTML directly to dist/ (assetsDir: ".")
COPY --from=builder /app/dist/server-bundle.js ./dist/
COPY --from=builder /app/dist/*.html ./dist/
COPY --from=builder /app/dist/*.js ./dist/
COPY --from=builder /app/dist/*.css ./dist/
COPY --from=builder /app/dist/static ./dist/static

# Copy only native modules needed at runtime (node-pty for terminal support)
COPY --from=builder /app/node_modules/@lydell ./node_modules/@lydell

# Create mux data directory
RUN mkdir -p /root/.mux

# Default environment variables
ENV NODE_ENV=production
ENV MUX_HOME=/root/.mux

# Expose server port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Run bundled mux server
# --host 0.0.0.0: bind to all interfaces (required for Docker networking)
# --port 3000: default port (can be remapped via docker run -p)
ENTRYPOINT ["node", "dist/server-bundle.js"]
CMD ["--host", "0.0.0.0", "--port", "3000"]
