# Selective Test Execution System

This system reduces CI time by running only the integration tests affected by code changes, rather than the full test suite on every PR.

## How It Works

1. **Coverage Map Generation**: A daily workflow runs all integration tests individually with code coverage, building a reverse index from source files to tests.

2. **Affected Test Selection**: When a PR runs, the system:
   - Restores the coverage map from cache
   - Identifies changed files via git diff
   - Looks up which tests cover those files
   - Runs only the affected tests

3. **Safe Fallbacks**: The system falls back to running all tests when:
   - Coverage map is missing or stale (>7 days)
   - Infrastructure files change (jest.config, package.json, etc.)
   - New test files are added
   - Changed source files aren't in the coverage map
   - Any error occurs during selection

## Files

- `types.ts` - Shared types and infrastructure file patterns
- `generate-coverage-map.ts` - Generates the coverage map by running tests with coverage
- `select-affected-tests.ts` - Selects tests based on changed files

## Usage

### Generate Coverage Map (local testing)

```bash
bun scripts/selective-tests/generate-coverage-map.ts --output coverage-map.json
```

This takes ~30-60 minutes as it runs each test file individually.

### Select Affected Tests

```bash
# Using git diff
bun scripts/selective-tests/select-affected-tests.ts \
  --map coverage-map.json \
  --base origin/main \
  --head HEAD \
  --output jest

# Using explicit file list
bun scripts/selective-tests/select-affected-tests.ts \
  --map coverage-map.json \
  --changed "src/node/services/workspaceService.ts,src/node/config.ts" \
  --output json
```

### Output Formats

- `jest` - Space-separated test files for Jest CLI, or `tests` for all tests
- `json` - Full result object with reasoning
- `list` - Newline-separated test files, or `ALL` for all tests

### Exit Codes

- `0` - Selection successful (may be empty test list)
- `2` - Fallback triggered (run all tests)
- `1` - Error

## CI Integration

The system integrates with `.github/workflows/ci.yml`:

1. Restores coverage map from cache
2. Runs selection script
3. Either runs selected tests or falls back to all tests
4. Skips tests entirely if no tests are affected

The coverage map is regenerated daily by `.github/workflows/coverage-map.yml` and cached for PR use.

## Infrastructure Files

These files trigger a full test run when changed (see `INFRASTRUCTURE_PATTERNS` in `types.ts`):

- Test configuration: `jest.config.cjs`, `babel.config.cjs`
- Build config: `tsconfig.json`, `package.json`, `bun.lockb`
- Test infrastructure: `tests/setup.ts`, `tests/integration/helpers.ts`
- Service container: `src/node/services/serviceContainer.ts`
- Shared types: `src/types/**`, `src/constants/**`

## Debugging

Use `--verbose` for detailed logging:

```bash
bun scripts/selective-tests/select-affected-tests.ts \
  --map coverage-map.json \
  --changed "src/node/services/aiService.ts" \
  --output json \
  --verbose
```
