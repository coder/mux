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

# Install dependencies and create Makefile sentinel so build targets don't reinstall.
RUN bun install --frozen-lockfile && \
    touch node_modules/.installed

# Copy build orchestration files used by Make targets.
COPY Makefile fmt.mk ./

# Copy source files needed for build
COPY src/ src/
COPY tsconfig.json tsconfig.main.json ./
COPY scripts/generate-version.sh scripts/generate-builtin-agents.sh scripts/generate-builtin-skills.sh scripts/
COPY scripts/gen_builtin_skills.ts scripts/
COPY docs/ docs/
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

# Build Docker runtime artifacts through Makefile so local/CI/Docker share one pipeline.
# This runs version generation, builtin content generation, main+renderer builds,
# server bundle creation, worker bundle creation, and runtime artifact assertions.
RUN make verify-docker-runtime-artifacts

# ==============================================================================
# Stage 2: Runtime
# ==============================================================================
FROM node:22-slim

# OCI image metadata — allows registries (GHCR, Docker Hub) to link the image
# back to the source repository and display version/description.
ARG VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/coder/mux"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.description="Mux server — parallel AI agent workflows"
LABEL org.opencontainers.image.licenses="AGPL-3.0"

WORKDIR /app

# Install runtime dependencies
# - git: required for workspace operations (clone, worktree, etc.)
# - openssh-client: required for SSH runtime support
RUN apt-get update && \
    apt-get install -y git openssh-client && \
    rm -rf /var/lib/apt/lists/*

# Copy runtime dependencies first so app-code changes don't invalidate these layers.
# - @lydell/node-pty: native module for terminal support
# - ssh2 + deps: externalized to avoid .node addon bundling issues
COPY --from=builder /app/node_modules/@lydell ./node_modules/@lydell
COPY --from=builder /app/node_modules/ssh2 ./node_modules/ssh2
COPY --from=builder /app/node_modules/asn1 ./node_modules/asn1
COPY --from=builder /app/node_modules/safer-buffer ./node_modules/safer-buffer
COPY --from=builder /app/node_modules/bcrypt-pbkdf ./node_modules/bcrypt-pbkdf
COPY --from=builder /app/node_modules/tweetnacl ./node_modules/tweetnacl

# Copy frontend/static assets from least to most volatile for better cache reuse.
# Vite outputs JS/CSS/HTML directly to dist/ (assetsDir: ".").
COPY --from=builder /app/dist/static ./dist/static
COPY --from=builder /app/dist/*.html ./dist/
COPY --from=builder /app/dist/*.css ./dist/
COPY --from=builder /app/dist/*.js ./dist/

# Copy runtime bundles last (most volatile layer during backend iteration).
COPY --from=builder /app/dist/runtime ./dist/runtime

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
ENTRYPOINT ["node", "dist/runtime/server-bundle.js"]
CMD ["--host", "0.0.0.0", "--port", "3000"]
