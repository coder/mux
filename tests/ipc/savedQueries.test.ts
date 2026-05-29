import { shouldRunIntegrationTests, createTestEnvironment, cleanupTestEnvironment } from "./setup";
import { resolveOrpcClient } from "./helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Saved Queries IPC", () => {
  test.concurrent(
    "save + get round-trip through IPC",
    async () => {
      const env = await createTestEnvironment();

      try {
        const client = resolveOrpcClient(env);
        const saved = await client.analytics.saveQuery({
          label: "Test Query",
          sql: "SELECT 1",
          chartType: "bar",
        });

        expect(saved.id).toBeDefined();
        expect(saved.label).toBe("Test Query");
        expect(saved.sql).toBe("SELECT 1");
        expect(saved.chartType).toBe("bar");

        const result = await client.analytics.getSavedQueries();
        expect(result.queries).toHaveLength(1);
        expect(result.queries[0].id).toBe(saved.id);
      } finally {
        await cleanupTestEnvironment(env);
      }
    },
    10000
  );

  test.concurrent(
    "update via IPC persists chart type change",
    async () => {
      const env = await createTestEnvironment();

      try {
        const client = resolveOrpcClient(env);
        const saved = await client.analytics.saveQuery({
          label: "Q1",
          sql: "SELECT 2",
        });

        const updated = await client.analytics.updateSavedQuery({
          id: saved.id,
          chartType: "line",
        });

        expect(updated.chartType).toBe("line");
        expect(updated.label).toBe("Q1");

        const persisted = await client.analytics.getSavedQueries();
        expect(persisted.queries.find((query) => query.id === saved.id)?.chartType).toBe("line");
      } finally {
        await cleanupTestEnvironment(env);
      }
    },
    10000
  );

  test.concurrent(
    "delete via IPC removes the query",
    async () => {
      const env = await createTestEnvironment();

      try {
        const client = resolveOrpcClient(env);
        const saved = await client.analytics.saveQuery({
          label: "Q2",
          sql: "SELECT 3",
        });

        const result = await client.analytics.deleteSavedQuery({ id: saved.id });
        expect(result.success).toBe(true);

        const remaining = await client.analytics.getSavedQueries();
        expect(remaining.queries.find((query) => query.id === saved.id)).toBeUndefined();
      } finally {
        await cleanupTestEnvironment(env);
      }
    },
    10000
  );
});
