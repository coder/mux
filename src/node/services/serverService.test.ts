import { describe, expect, test } from "bun:test";
import { ServerService } from "./serverService";

describe("ServerService", () => {
  test("initializes with null path", async () => {
    const service = new ServerService();
    expect(await service.getLaunchProject()).toBeNull();
  });

  test("sets and gets project path", async () => {
    const service = new ServerService();
    service.setLaunchProject("/test/path");
    expect(await service.getLaunchProject()).toBe("/test/path");
  });

  test("updates project path", async () => {
    const service = new ServerService();
    service.setLaunchProject("/path/1");
    expect(await service.getLaunchProject()).toBe("/path/1");
    service.setLaunchProject("/path/2");
    expect(await service.getLaunchProject()).toBe("/path/2");
  });

  test("clears project path", async () => {
    const service = new ServerService();
    service.setLaunchProject("/test/path");
    expect(await service.getLaunchProject()).toBe("/test/path");
    service.setLaunchProject(null);
    expect(await service.getLaunchProject()).toBeNull();
  });
});
