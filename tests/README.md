# Tests

## Running Tests

### Unit Tests
```bash
make test
```

Runs fast, isolated unit tests that don't require external services.

### Integration Tests
```bash
TEST_INTEGRATION=1 make test-integration
```

Runs integration tests that test IPC handlers, runtimes, and end-to-end workflows.

**Requirements:**
- **Docker** (required for SSH runtime tests)
- API keys for provider tests:
  - `ANTHROPIC_API_KEY` - For Anthropic provider tests

**Why Docker is required:** Integration tests for SSH workspaces start a temporary SSH server in a Docker container to test remote workspace operations (creation, forking, editing, etc.) without requiring a real remote server.

If Docker is not available:
1. Install Docker for your platform
2. Or skip integration tests by unsetting `TEST_INTEGRATION`

**Note:** Tests will fail loudly with a clear error message if Docker is not available rather than silently skipping, ensuring CI catches missing dependencies.

## Test Organization

- `tests/ipcMain/` - Integration tests for IPC handlers
- `tests/runtime/` - Runtime-specific fixtures and helpers
- `tests/e2e/` - End-to-end tests
- `src/**/*.test.ts` - Unit tests colocated with source code

## SSH Test Setup

For tests that need SSH runtime, use the shared helpers in `tests/ipcMain/setup.ts`:

```typescript
import { setupSSHServer, cleanupSSHServer } from "./setup";

let sshConfig: Awaited<ReturnType<typeof setupSSHServer>> | undefined;

beforeAll(async () => {
  sshConfig = await setupSSHServer();
}, 120000);

afterAll(async () => {
  await cleanupSSHServer(sshConfig);
}, 30000);
```

This ensures:
- Docker availability is checked (fails test if missing)
- SSH server is started once per test suite
- Consistent error messages across all SSH tests
- Proper cleanup after tests complete
