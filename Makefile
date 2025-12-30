# Build System
# ============
# This Makefile orchestrates the mux build process.
#
# Quick Start:
#   make help          - Show all available targets
#   make dev           - Start development server with hot reload
#   make build         - Build all targets (parallel when possible)
#   make static-check  - Run all static checks (lint + typecheck + fmt-check)
#   make test          - Run tests
#
# Parallelism:
#   Runs in parallel by default for faster builds. Use -j1 for sequential execution.
#   Individual targets can opt out with .NOTPARALLEL if needed.
#
# Backwards Compatibility:
#   All commands also work via `bun run` (e.g., `bun run dev` calls `make dev`)
#
# Adding New Targets:
#   Add `## Description` after the target to make it appear in `make help`
#
# Build Reproducibility:
#   AVOID CONDITIONAL BRANCHES (if/else) IN BUILD TARGETS AT ALL COSTS.
#   Branches reduce reproducibility - builds should fail fast with clear errors
#   if dependencies are missing, not silently fall back to different behavior.
#
# Telemetry in Development:
#   Telemetry is disabled by default in dev mode (MUX_DISABLE_TELEMETRY=1).
#   To enable it (e.g., for testing PostHog experiments), set:
#     MUX_ENABLE_TELEMETRY_IN_DEV=1 make dev
#   This single env var is sufficient - no need to also set MUX_DISABLE_TELEMETRY=0.

# Use PATH-resolved bash for portability across different systems.
# - Windows: /usr/bin/bash doesn't exist in Chocolatey's make environment or GitHub Actions
# - NixOS: /bin/bash doesn't exist, bash is in /nix/store/...
# - Other systems: /usr/bin/env bash resolves from PATH
ifeq ($(OS),Windows_NT)
SHELL := bash
else
SHELL := /usr/bin/env bash
endif
.SHELLFLAGS := -eu -o pipefail -c

# Enable parallel execution by default (only if user didn't specify -j)
ifeq (,$(filter -j%,$(MAKEFLAGS)))
MAKEFLAGS += -j
endif

# Include formatting rules
include fmt.mk

.PHONY: all build dev start clean help
.PHONY: build-renderer version build-icons build-static
.PHONY: lint lint-fix typecheck typecheck-react-native static-check
.PHONY: test test-unit test-integration test-watch test-coverage test-e2e smoke-test
.PHONY: dist dist-mac dist-win dist-linux install-mac-arm64
.PHONY: vscode-ext vscode-ext-install
.PHONY: docs-server check-docs-links
.PHONY: storybook storybook-build test-storybook chromatic
.PHONY: benchmark-terminal
.PHONY: ensure-deps rebuild-native mux
.PHONY: check-eager-imports check-bundle-size check-startup

# Build tools
TSGO := bun run node_modules/@typescript/native-preview/bin/tsgo.js

# Node.js version check
REQUIRED_NODE_VERSION := 20
NODE_VERSION := $(shell node --version | sed 's/v\([0-9]*\).*/\1/')

define check_node_version
	@if [ "$(NODE_VERSION)" -lt "$(REQUIRED_NODE_VERSION)" ]; then \
		echo "Error: Node.js v$(REQUIRED_NODE_VERSION) or higher is required"; \
		echo "Current version: v$(NODE_VERSION)"; \
		echo ""; \
		echo "To upgrade Node.js:"; \
		echo "  1. Install 'n' version manager: curl -L https://raw.githubusercontent.com/tj/n/master/bin/n | sudo bash -s -- lts"; \
		echo "  2. Or use 'n' if already installed: sudo n $(REQUIRED_NODE_VERSION)"; \
		echo ""; \
		exit 1; \
	fi
endef

# Detect if browser opener is available that Storybook can use
# Storybook uses 'open' package which tries xdg-open on Linux, open on macOS, start on Windows
HAS_BROWSER_OPENER := $(shell command -v xdg-open >/dev/null 2>&1 && echo "yes" || echo "no")
STORYBOOK_OPEN_FLAG := $(if $(filter yes,$(HAS_BROWSER_OPENER)),,--no-open)

TS_SOURCES := $(shell find src -type f \( -name '*.ts' -o -name '*.tsx' \))

# Default target
all: build

# Sentinel file to track when dependencies are installed
# Depends on package.json and bun.lock - rebuilds if either changes
node_modules/.installed: package.json bun.lock
	@echo "Dependencies out of date or missing, running bun install..."
	@bun install
	@touch node_modules/.installed

# Mobile dependencies - separate from main project
mobile/node_modules/.installed: mobile/package.json mobile/bun.lock
	@echo "Installing mobile dependencies..."
	@cd mobile && bun install
	@touch mobile/node_modules/.installed

# Legacy target for backwards compatibility
ensure-deps: node_modules/.installed

# Rebuild native modules for Electron
rebuild-native: node_modules/.installed ## Rebuild native modules (node-pty) for Electron
	@echo "Rebuilding native modules for Electron..."
	@npx @electron/rebuild -f -m node_modules/node-pty
	@echo "Native modules rebuilt successfully"

# Run compiled CLI with trailing arguments (builds only if missing)
mux: ## Run the compiled mux CLI (e.g., make mux server --port 3000)
	@test -f dist/cli/index.js -a -f dist/cli/api.mjs || $(MAKE) build-main
	@node dist/cli/index.js $(filter-out $@,$(MAKECMDGOALS))

# Catch unknown targets passed to mux (prevents "No rule to make target" errors)
ifneq ($(filter mux,$(MAKECMDGOALS)),)
%:
	@:
endif

## Help
help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Available targets:'
	@grep -h -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

## Development
ifeq ($(OS),Windows_NT)
dev: node_modules/.installed build-main ## Start development server (Vite + nodemon watcher for Windows compatibility)
	@echo "Starting dev mode (3 watchers: nodemon for main process, esbuild for api, vite for renderer)..."
	# On Windows, use npm run because bunx doesn't correctly pass arguments to concurrently
	# https://github.com/oven-sh/bun/issues/18275
	@MUX_DISABLE_TELEMETRY=$(if $(MUX_ENABLE_TELEMETRY_IN_DEV),,$(or $(MUX_DISABLE_TELEMETRY),1)) NODE_OPTIONS="--max-old-space-size=4096" npm x concurrently -k --raw \
		"bun x nodemon --watch src --watch tsconfig.main.json --watch tsconfig.json --ext ts,tsx,json --ignore dist --ignore node_modules --exec node scripts/build-main-watch.js" \
		"npx esbuild src/cli/api.ts --bundle --format=esm --platform=node --target=node20 --outfile=dist/cli/api.mjs --external:zod --external:commander --external:@trpc/server --banner:js='import { createRequire } from \"module\"; const require = createRequire(import.meta.url);' --watch" \
		"vite"
else
dev: node_modules/.installed build-main build-preload ## Start development server (Vite + tsgo watcher for 10x faster type checking)
	@MUX_DISABLE_TELEMETRY=$(if $(MUX_ENABLE_TELEMETRY_IN_DEV),,$(or $(MUX_DISABLE_TELEMETRY),1)) bun x concurrently -k \
		"bun x concurrently \"$(TSGO) -w -p tsconfig.main.json\" \"bun x tsc-alias -w -p tsconfig.main.json\"" \
		"bun x esbuild src/cli/api.ts --bundle --format=esm --platform=node --target=node20 --outfile=dist/cli/api.mjs --external:zod --external:commander --external:@trpc/server --banner:js='import { createRequire } from \"module\"; const require = createRequire(import.meta.url);' --watch" \
		"vite"
endif

ifeq ($(OS),Windows_NT)
dev-server: node_modules/.installed build-main ## Start server mode with hot reload (backend :3000 + frontend :5173). Use VITE_HOST=0.0.0.0 BACKEND_HOST=0.0.0.0 for remote access
	@echo "Starting dev-server..."
	@echo "  Backend (IPC/WebSocket): http://$(or $(BACKEND_HOST),localhost):$(or $(BACKEND_PORT),3000)"
	@echo "  Frontend (with HMR):     http://$(or $(VITE_HOST),localhost):$(or $(VITE_PORT),5173)"
	@echo ""
	@echo "For remote access: make dev-server VITE_HOST=0.0.0.0 BACKEND_HOST=0.0.0.0"
	@# On Windows, use npm run because bunx doesn't correctly pass arguments
	@MUX_DISABLE_TELEMETRY=$(if $(MUX_ENABLE_TELEMETRY_IN_DEV),,$(or $(MUX_DISABLE_TELEMETRY),1)) npmx concurrently -k \
		"npmx nodemon --watch src --watch tsconfig.main.json --watch tsconfig.json --ext ts,tsx,json --ignore dist --ignore node_modules --exec node scripts/build-main-watch.js" \
		"npx esbuild src/cli/api.ts --bundle --format=esm --platform=node --target=node20 --outfile=dist/cli/api.mjs --external:zod --external:commander --external:@trpc/server --banner:js='import { createRequire } from \"module\"; const require = createRequire(import.meta.url);' --watch" \
		"npmx nodemon --watch dist/cli/index.js --watch dist/cli/server.js --delay 500ms --exec \"node dist/cli/index.js server --host $(or $(BACKEND_HOST),localhost) --port $(or $(BACKEND_PORT),3000)\"" \
		"$(SHELL) -lc \"MUX_VITE_HOST=$(or $(VITE_HOST),127.0.0.1) MUX_VITE_PORT=$(or $(VITE_PORT),5173) VITE_BACKEND_URL=http://$(or $(BACKEND_HOST),localhost):$(or $(BACKEND_PORT),3000) vite\""
else
dev-server: node_modules/.installed build-main ## Start server mode with hot reload (backend :3000 + frontend :5173). Use VITE_HOST=0.0.0.0 BACKEND_HOST=0.0.0.0 for remote access
	@echo "Starting dev-server..."
	@echo "  Backend (IPC/WebSocket): http://$(or $(BACKEND_HOST),localhost):$(or $(BACKEND_PORT),3000)"
	@echo "  Frontend (with HMR):     http://$(or $(VITE_HOST),localhost):$(or $(VITE_PORT),5173)"
	@echo ""
	@echo "For remote access: make dev-server VITE_HOST=0.0.0.0 BACKEND_HOST=0.0.0.0"
	@MUX_DISABLE_TELEMETRY=$(if $(MUX_ENABLE_TELEMETRY_IN_DEV),,$(or $(MUX_DISABLE_TELEMETRY),1)) bun x concurrently -k \
		"bun x concurrently \"$(TSGO) -w -p tsconfig.main.json\" \"bun x tsc-alias -w -p tsconfig.main.json\"" \
		"bun x esbuild src/cli/api.ts --bundle --format=esm --platform=node --target=node20 --outfile=dist/cli/api.mjs --external:zod --external:commander --external:@trpc/server --banner:js='import { createRequire } from \"module\"; const require = createRequire(import.meta.url);' --watch" \
		"bun x nodemon --watch dist/cli/index.js --watch dist/cli/server.js --delay 500ms --exec 'NODE_ENV=development node dist/cli/index.js server --host $(or $(BACKEND_HOST),localhost) --port $(or $(BACKEND_PORT),3000)'" \
		"MUX_VITE_HOST=$(or $(VITE_HOST),127.0.0.1) MUX_VITE_PORT=$(or $(VITE_PORT),5173) VITE_BACKEND_URL=http://$(or $(BACKEND_HOST),localhost):$(or $(BACKEND_PORT),3000) vite"
endif



start: node_modules/.installed build-main build-preload build-static ## Build and start Electron app
	@NODE_ENV=development MUX_DISABLE_TELEMETRY=$(if $(MUX_ENABLE_TELEMETRY_IN_DEV),,$(or $(MUX_DISABLE_TELEMETRY),1)) bunx electron --remote-debugging-port=9222 .

## Build targets (can run in parallel)
build: node_modules/.installed src/version.ts build-renderer build-main build-preload build-icons build-static ## Build all targets

build-main: node_modules/.installed dist/cli/index.js dist/cli/api.mjs ## Build main process

dist/cli/index.js: src/cli/index.ts src/desktop/main.ts src/cli/server.ts src/version.ts tsconfig.main.json tsconfig.json $(TS_SOURCES)
	@echo "Building main process..."
	@NODE_ENV=production $(TSGO) -p tsconfig.main.json
	@NODE_ENV=production bun x tsc-alias -p tsconfig.main.json

# Build API CLI as ESM bundle (trpc-cli requires ESM with top-level await)
dist/cli/api.mjs: src/cli/api.ts src/cli/proxifyOrpc.ts $(TS_SOURCES)
	@echo "Building API CLI (ESM)..."
	@bun x esbuild src/cli/api.ts \
		--bundle \
		--format=esm \
		--platform=node \
		--target=node20 \
		--outfile=dist/cli/api.mjs \
		--banner:js='import { createRequire } from "module"; const require = createRequire(import.meta.url);' \
		--external:zod \
		--external:commander \
		--external:@trpc/server

build-preload: node_modules/.installed dist/preload.js ## Build preload script

dist/preload.js: src/desktop/preload.ts $(TS_SOURCES)
	@echo "Building preload script..."
	@NODE_ENV=production bun build src/desktop/preload.ts \
		--format=cjs \
		--target=node \
		--external=electron \
		--sourcemap=inline \
		--outfile=dist/preload.js

build-renderer: node_modules/.installed src/version.ts ## Build renderer process
	@echo "Building renderer..."
	@bun x vite build

build-static: ## Copy static assets to dist
	@echo "Copying static assets..."
	@mkdir -p dist
	@cp static/splash.html dist/splash.html
	@cp -r public/* dist/
	@# Copy TypeScript lib files for PTC runtime type validation (es5 through es2023).
	@# electron-builder ignores .d.ts files by default and this cannot be overridden:
	@# https://github.com/electron-userland/electron-builder/issues/5064
	@# Workaround: rename to .d.ts.txt extension to bypass the filter.
	@mkdir -p dist/typescript-lib
	@for f in node_modules/typescript/lib/lib.es5.d.ts \
	          node_modules/typescript/lib/lib.es2015*.d.ts \
	          node_modules/typescript/lib/lib.es2016*.d.ts \
	          node_modules/typescript/lib/lib.es2017*.d.ts \
	          node_modules/typescript/lib/lib.es2018*.d.ts \
	          node_modules/typescript/lib/lib.es2019*.d.ts \
	          node_modules/typescript/lib/lib.es2020*.d.ts \
	          node_modules/typescript/lib/lib.es2021*.d.ts \
	          node_modules/typescript/lib/lib.es2022*.d.ts \
	          node_modules/typescript/lib/lib.es2023*.d.ts; do \
		cp "$$f" "dist/typescript-lib/$$(basename $$f).txt"; \
	done

# Always regenerate version file (marked as .PHONY above)
version: ## Generate version file
	@./scripts/generate-version.sh

src/version.ts: version

# Platform-specific icon targets
ifeq ($(shell uname), Darwin)
build-icons: build/icon.icns build/icon.png ## Generate Electron app icons from logo (macOS builds both)

build/icon.icns: docs/img/logo.webp scripts/generate-icons.ts
	@echo "Generating macOS ICNS icon..."
	@bun scripts/generate-icons.ts icns
else
build-icons: build/icon.png ## Generate Electron app icons from logo (Linux builds PNG only)
endif

build/icon.png: docs/img/logo.webp scripts/generate-icons.ts
	@echo "Generating PNG icon..."
	@bun scripts/generate-icons.ts png

## Quality checks (can run in parallel)
static-check: lint typecheck fmt-check check-eager-imports check-bench-agent check-docs-links ## Run all static checks

check-bench-agent: ## Verify terminal-bench agent configuration and imports
	@./scripts/check-bench-agent.sh

lint: node_modules/.installed src/version.ts ## Run ESLint (typecheck runs in separate target)
	@./scripts/lint.sh

lint-fix: node_modules/.installed src/version.ts ## Run linter with --fix
	@./scripts/lint.sh --fix

ifeq ($(OS),Windows_NT)
typecheck: node_modules/.installed src/version.ts ## Run TypeScript type checking (uses tsgo for 10x speedup)
	@# On Windows, use npm run because bun x doesn't correctly pass arguments
	@npmx concurrently -g \
		"$(TSGO) --noEmit" \
		"$(TSGO) --noEmit -p tsconfig.main.json"
else
typecheck: node_modules/.installed src/version.ts
	@bun x concurrently -g \
		"$(TSGO) --noEmit" \
		"$(TSGO) --noEmit -p tsconfig.main.json"
endif

typecheck-react-native: mobile/node_modules/.installed ## Run TypeScript type checking for React Native app
	@echo "Type checking React Native app..."
	@cd mobile && bunx tsc --noEmit

check-deadcode: node_modules/.installed ## Check for potential dead code (manual only, not in static-check)
	@echo "Checking for potential dead code with ts-prune..."
	@echo "(Note: Some unused exports are legitimate - types, public APIs, entry points, etc.)"
	@echo ""
	@bun x ts-prune -i '(test|spec|mock|bench|debug|storybook)' \
		| grep -v "used in module" \
		| grep -v "src/App.tsx.*default" \
		| grep -v "src/types/" \
		| grep -v "telemetry/index.ts" \
		|| echo "✓ No obvious dead code found"

## Testing
test-integration: node_modules/.installed build-main ## Run all tests (unit + integration)
	@bun test src
	@TEST_INTEGRATION=1 bun x jest tests

test-unit: node_modules/.installed build-main ## Run unit tests
	@bun test src

test: test-unit ## Alias for test-unit

test-watch: ## Run tests in watch mode
	@./scripts/test.sh --watch

test-coverage: ## Run tests with coverage
	@./scripts/test.sh --coverage


smoke-test: build ## Run smoke test on npm package
	@echo "Building npm package tarball..."
	@npm pack
	@TARBALL=$$(ls mux-*.tgz | head -1); \
	echo "Running smoke test on $$TARBALL..."; \
	PACKAGE_TARBALL="$$TARBALL" ./scripts/smoke-test.sh; \
	EXIT_CODE=$$?; \
	rm -f "$$TARBALL"; \
	exit $$EXIT_CODE

test-e2e: ## Run end-to-end tests
	@$(MAKE) build
	@MUX_E2E_LOAD_DIST=1 MUX_E2E_SKIP_BUILD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 bun x playwright test --project=electron $(PLAYWRIGHT_ARGS)

## Distribution
dist: build ## Build distributable packages
	@bun x electron-builder --publish never

# Parallel macOS builds - notarization happens concurrently
dist-mac: build ## Build macOS distributables (x64 + arm64)
	@if [ -n "$$CSC_LINK" ]; then \
		echo "🔐 Code signing enabled - building sequentially to avoid keychain conflicts..."; \
		bun x electron-builder --mac --x64 --publish never && \
		bun x electron-builder --mac --arm64 --publish never; \
	else \
		echo "Building macOS architectures in parallel..."; \
		bun x electron-builder --mac --x64 --publish never & pid1=$$! ; \
		bun x electron-builder --mac --arm64 --publish never & pid2=$$! ; \
		wait $$pid1 && wait $$pid2; \
	fi
	@echo "✅ Both architectures built successfully"

dist-mac-release: build ## Build and publish macOS distributables (x64 + arm64)
	@if [ -n "$$CSC_LINK" ]; then \
		echo "🔐 Code signing enabled - building sequentially to avoid keychain conflicts..."; \
		bun x electron-builder --mac --x64 --publish always && \
		bun x electron-builder --mac --arm64 --publish always; \
	else \
		echo "Building and publishing macOS architectures in parallel..."; \
		bun x electron-builder --mac --x64 --publish always & pid1=$$! ; \
		bun x electron-builder --mac --arm64 --publish always & pid2=$$! ; \
		wait $$pid1 && wait $$pid2; \
	fi
	@echo "✅ Both architectures built and published successfully"

dist-mac-x64: build ## Build macOS x64 distributable only
	@echo "Building macOS x64..."
	@bun x electron-builder --mac --x64 --publish never

dist-mac-arm64: build ## Build macOS arm64 distributable only
	@echo "Building macOS arm64..."
	@bun x electron-builder --mac --arm64 --publish never

install-mac-arm64: dist-mac-arm64 ## Build and install macOS arm64 app to /Applications
	@echo "Installing mux.app to /Applications..."
	@rm -rf /Applications/mux.app
	@cp -R release/mac-arm64/mux.app /Applications/
	@echo "Installed mux.app to /Applications"

dist-win: build ## Build Windows distributable
	@bun x electron-builder --win --publish never

dist-linux: build ## Build Linux distributable
	@bun x electron-builder --linux --publish never

## VS Code Extension (delegates to vscode/Makefile)

vscode-ext: ## Build VS Code extension (.vsix)
	@$(MAKE) -C vscode build

vscode-ext-install: ## Build and install VS Code extension locally
	@$(MAKE) -C vscode install

## Documentation
docs-server: node_modules/.installed ## Serve documentation locally (Mintlify dev server)
	@cd docs && npx mintlify dev

check-docs-links: ## Check documentation for broken links
	@echo "🔗 Checking documentation links..."
	@cd docs && npx mintlify broken-links

## Storybook
storybook: node_modules/.installed ## Start Storybook development server
	$(check_node_version)
	@bun x storybook dev -p 6006 $(STORYBOOK_OPEN_FLAG)

storybook-build: node_modules/.installed src/version.ts ## Build static Storybook
	$(check_node_version)
	@bun x storybook build

test-storybook: node_modules/.installed ## Run Storybook interaction tests (requires Storybook to be running or built)
	$(check_node_version)
	@bun x test-storybook

chromatic: node_modules/.installed ## Run Chromatic for visual regression testing
	$(check_node_version)
	@bun x chromatic --exit-zero-on-changes

## Benchmarks
benchmark-terminal: ## Run Terminal-Bench with the mux agent (use TB_DATASET/TB_SAMPLE_SIZE/TB_TIMEOUT/TB_ARGS to customize)
	@TB_DATASET=$${TB_DATASET:-terminal-bench-core==0.1.1}; \
	TB_TIMEOUT=$${TB_TIMEOUT:-1800}; \
	CONCURRENCY_FLAG=$${TB_CONCURRENCY:+--n-concurrent $$TB_CONCURRENCY}; \
	LIVESTREAM_FLAG=$${TB_LIVESTREAM:+--livestream}; \
	TASK_ID_FLAGS=""; \
	if [ -n "$$TB_SAMPLE_SIZE" ]; then \
		echo "Ensuring dataset $$TB_DATASET is downloaded..."; \
		uvx terminal-bench datasets download --dataset "$$TB_DATASET" 2>&1 | grep -v "already exists" || true; \
		echo "Sampling $$TB_SAMPLE_SIZE tasks from $$TB_DATASET..."; \
		TASK_IDS=$$(python3 benchmarks/terminal_bench/sample_tasks.py --dataset "$$TB_DATASET" --sample-size "$$TB_SAMPLE_SIZE" --format space) || { \
			echo "Error: Failed to sample tasks" >&2; \
			exit 1; \
		}; \
		if [ -z "$$TASK_IDS" ]; then \
			echo "Error: Sampling returned no task IDs" >&2; \
			exit 1; \
		fi; \
		for task_id in $$TASK_IDS; do \
			TASK_ID_FLAGS="$$TASK_ID_FLAGS --task-id $$task_id"; \
		done; \
		echo "Selected task IDs: $$TASK_IDS"; \
	fi; \
	echo "Using timeout: $$TB_TIMEOUT seconds"; \
	echo "Running Terminal-Bench with dataset $$TB_DATASET"; \
	export MUX_TIMEOUT_MS=$$((TB_TIMEOUT * 1000)); \
	uvx terminal-bench run \
		--dataset "$$TB_DATASET" \
		--agent-import-path benchmarks.terminal_bench.mux_agent:MuxAgent \
		--global-agent-timeout-sec $$TB_TIMEOUT \
		$$CONCURRENCY_FLAG \
		$$LIVESTREAM_FLAG \
		$$TASK_ID_FLAGS \
		$${TB_ARGS}

## Clean
clean: ## Clean build artifacts
	@echo "Cleaning build artifacts..."
	@rm -rf dist release build/icon.icns build/icon.png
	@echo "Done!"

## Startup Performance Checks
check-eager-imports: ## Check for eager AI SDK imports in critical files
	@./scripts/check_eager_imports.sh

check-bundle-size: build ## Check that bundle sizes are within limits
	@./scripts/check_bundle_size.sh

check-startup: check-eager-imports check-bundle-size ## Run all startup performance checks

# Parallel build optimization - these can run concurrently
.NOTPARALLEL: build-main  # TypeScript can handle its own parallelism
