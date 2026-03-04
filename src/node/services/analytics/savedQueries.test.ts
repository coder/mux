import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SavedQuery } from "@/common/types/savedQueries";
import { Config } from "@/node/config";
import { AnalyticsService } from "./analyticsService";

describe("AnalyticsService saved queries", () => {
  let rootDir = "";
  let service: AnalyticsService;
  let savedQueriesPath = "";

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-saved-queries-test-"));
    const config = new Config(rootDir);
    service = new AnalyticsService(config);
    savedQueriesPath = path.join(rootDir, "analytics", "saved-queries.json");
  });

  afterEach(async () => {
    await service.dispose();
    if (rootDir.length > 0) {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  test("getSavedQueries returns empty array when file does not exist", async () => {
    await expect(service.getSavedQueries()).resolves.toEqual({ queries: [] });
  });

  test("saveQuery creates file and returns query with generated id", async () => {
    const savedQuery = await service.saveQuery({
      label: "Daily cost",
      sql: "SELECT 1",
      chartType: "line",
    });

    expect(savedQuery.id.length).toBeGreaterThan(0);
    expect(savedQuery.label).toBe("Daily cost");
    expect(savedQuery.sql).toBe("SELECT 1");
    expect(savedQuery.chartType).toBe("line");
    expect(savedQuery.order).toBe(0);
    expect(Number.isNaN(Date.parse(savedQuery.createdAt))).toBe(false);

    const onDisk = JSON.parse(await fs.readFile(savedQueriesPath, "utf8")) as {
      queries: SavedQuery[];
    };
    expect(onDisk.queries).toHaveLength(1);
    expect(onDisk.queries[0]).toEqual(savedQuery);
  });

  test("saveQuery auto-increments order", async () => {
    const first = await service.saveQuery({ label: "Q1", sql: "SELECT 1" });
    const second = await service.saveQuery({ label: "Q2", sql: "SELECT 2" });
    const third = await service.saveQuery({ label: "Q3", sql: "SELECT 3" });

    expect(first.order).toBe(0);
    expect(second.order).toBe(1);
    expect(third.order).toBe(2);
  });

  test("getSavedQueries returns queries sorted by order", async () => {
    const queries: SavedQuery[] = [
      {
        id: "q-2",
        label: "Second",
        sql: "SELECT 2",
        chartType: "bar",
        order: 2,
        createdAt: "2025-01-01T00:00:02.000Z",
      },
      {
        id: "q-0",
        label: "First",
        sql: "SELECT 1",
        chartType: null,
        order: 0,
        createdAt: "2025-01-01T00:00:00.000Z",
      },
      {
        id: "q-1",
        label: "Middle",
        sql: "SELECT 1.5",
        chartType: "line",
        order: 1,
        createdAt: "2025-01-01T00:00:01.000Z",
      },
    ];

    await fs.mkdir(path.dirname(savedQueriesPath), { recursive: true });
    await fs.writeFile(savedQueriesPath, JSON.stringify({ queries }, null, 2));

    const result = await service.getSavedQueries();
    expect(result.queries.map((query) => query.id)).toEqual(["q-0", "q-1", "q-2"]);
  });

  test("updateSavedQuery updates only provided fields", async () => {
    const saved = await service.saveQuery({
      label: "Original label",
      sql: "SELECT 1",
      chartType: "line",
    });

    const updated = await service.updateSavedQuery({
      id: saved.id,
      label: "Updated label",
    });

    expect(updated.id).toBe(saved.id);
    expect(updated.label).toBe("Updated label");
    expect(updated.sql).toBe(saved.sql);
    expect(updated.chartType).toBe(saved.chartType);
    expect(updated.order).toBe(saved.order);
    expect(updated.createdAt).toBe(saved.createdAt);
  });

  test("updateSavedQuery throws for non-existent id", async () => {
    await expect(
      service.updateSavedQuery({
        id: "does-not-exist",
        label: "Updated",
      })
    ).rejects.toThrow("Saved query not found");
  });

  test("deleteSavedQuery removes query and returns success true", async () => {
    const saved = await service.saveQuery({ label: "Delete me", sql: "SELECT 1" });

    const result = await service.deleteSavedQuery({ id: saved.id });

    expect(result).toEqual({ success: true });
    await expect(service.getSavedQueries()).resolves.toEqual({ queries: [] });
  });

  test("deleteSavedQuery returns success false for non-existent id", async () => {
    const result = await service.deleteSavedQuery({ id: "missing" });
    expect(result).toEqual({ success: false });
  });

  test("readSavedQueries recovers from corrupted JSON file", async () => {
    await fs.mkdir(path.dirname(savedQueriesPath), { recursive: true });
    await fs.writeFile(savedQueriesPath, "not json");

    await expect(service.getSavedQueries()).resolves.toEqual({ queries: [] });
  });
});
