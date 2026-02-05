import { describe, expect, test } from "bun:test";
import { eventIterator, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/node";
import express from "express";
import assert from "node:assert/strict";
import http from "node:http";
import { z } from "zod";

import { encodeRemoteWorkspaceId } from "@/common/utils/remoteMuxIds";
import { createRemoteClient } from "@/node/remote/remoteOrpcClient";

import type { ORPCContext } from "./context";
import { createFederationMiddleware } from "./federationMiddleware";

type RPCHandlerRouter = ConstructorParameters<typeof RPCHandler>[0];

type TestOrpcServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

async function createTestOrpcServer(params: {
  router: RPCHandlerRouter;
  context: ORPCContext;
}): Promise<TestOrpcServer> {
  const app = express();
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: false }));

  const handler = new RPCHandler(params.router);

  app.use("/orpc", async (req, res, next) => {
    const { matched } = await handler.handle(req, res, {
      prefix: "/orpc",
      context: { ...params.context, headers: req.headers },
    });

    if (matched) {
      return;
    }

    next();
  });

  const httpServer = http.createServer(app);

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });

  const address = httpServer.address();
  assert(address && typeof address === "object", "createTestOrpcServer: expected a bound port");

  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}

interface TestOrpcClient {
  workspace: {
    getPlanContent: (input: {
      workspaceId: string;
    }) => Promise<{ workspaceId: string; content: string }>;
    backgroundBashes: {
      subscribe: (
        input: { workspaceId: string },
        options?: { signal?: AbortSignal }
      ) => Promise<AsyncIterable<{ workspaceId: string; event: string }>>;
    };
  };
  tasks: {
    create: (input: { workspaceId: string }) => Promise<{ workspaceId: string; taskId: string }>;
  };
}

describe("createFederationMiddleware", () => {
  test("proxies requests with remote.* IDs and rewrites returned IDs", async () => {
    const remoteServerId = "test-remote";
    const remoteWorkspaceId = "remote-workspace";
    const encodedWorkspaceId = encodeRemoteWorkspaceId(remoteServerId, remoteWorkspaceId);

    const remoteGetPlanInputs: string[] = [];
    const remoteSubscribeInputs: string[] = [];
    const remoteTaskCreateInputs: string[] = [];

    const workspaceIdInput = z.object({ workspaceId: z.string() });
    const getPlanContentOutput = z.object({ workspaceId: z.string(), content: z.string() });
    const backgroundBashEventOutput = z.object({ workspaceId: z.string(), event: z.string() });
    const tasksCreateOutput = z.object({ workspaceId: z.string(), taskId: z.string() });

    const remoteT = os.$context<ORPCContext>();

    const remoteRouter = remoteT.router({
      workspace: {
        getPlanContent: remoteT
          .input(workspaceIdInput)
          .output(getPlanContentOutput)
          .handler(async ({ input }) => {
            remoteGetPlanInputs.push(input.workspaceId);
            return { workspaceId: input.workspaceId, content: "remote-plan" };
          }),
        backgroundBashes: {
          subscribe: remoteT
            .input(workspaceIdInput)
            .output(eventIterator(backgroundBashEventOutput))
            .handler(async function* ({ input }) {
              remoteSubscribeInputs.push(input.workspaceId);
              yield { workspaceId: input.workspaceId, event: "hello" };
            }),
        },
      },
      tasks: {
        create: remoteT
          .input(workspaceIdInput)
          .output(tasksCreateOutput)
          .handler(async ({ input }) => {
            remoteTaskCreateInputs.push(input.workspaceId);
            return { workspaceId: input.workspaceId, taskId: `task-${input.workspaceId}` };
          }),
      },
    });

    const localT = os.$context<ORPCContext>().use(createFederationMiddleware());

    const localRouter = localT.router({
      workspace: {
        getPlanContent: localT
          .input(workspaceIdInput)
          .output(getPlanContentOutput)
          .handler(async () => {
            throw new Error("local workspace.getPlanContent handler should not be invoked");
          }),
        backgroundBashes: {
          subscribe: localT
            .input(workspaceIdInput)
            .output(eventIterator(backgroundBashEventOutput))
            .handler(async function* () {
              throw new Error(
                "local workspace.backgroundBashes.subscribe handler should not be invoked"
              );
            }),
        },
      },
      tasks: {
        create: localT
          .input(workspaceIdInput)
          .output(tasksCreateOutput)
          .handler(async () => {
            throw new Error("local tasks.create handler should not be invoked");
          }),
      },
    });

    const remoteContext: Partial<ORPCContext> = {};

    let remoteServer: TestOrpcServer | null = null;
    let localServer: TestOrpcServer | null = null;

    try {
      remoteServer = await createTestOrpcServer({
        router: remoteRouter as unknown as RPCHandlerRouter,
        context: remoteContext as ORPCContext,
      });

      const localContext: Partial<ORPCContext> = {
        config: {
          loadConfigOrDefault: () =>
            ({
              remoteServers: [
                {
                  id: remoteServerId,
                  label: "Test remote",
                  baseUrl: remoteServer.baseUrl,
                  projectMappings: [],
                },
              ],
            }) as unknown,
        } as unknown as ORPCContext["config"],
        remoteServersService: {
          getAuthToken: () => null,
        } as unknown as ORPCContext["remoteServersService"],
      };

      localServer = await createTestOrpcServer({
        router: localRouter as unknown as RPCHandlerRouter,
        context: localContext as ORPCContext,
      });

      const client = createRemoteClient<TestOrpcClient>({ baseUrl: localServer.baseUrl });

      const plan = await client.workspace.getPlanContent({ workspaceId: encodedWorkspaceId });
      expect(plan).toEqual({ workspaceId: encodedWorkspaceId, content: "remote-plan" });

      const created = await client.tasks.create({ workspaceId: encodedWorkspaceId });
      expect(created.workspaceId).toBe(encodedWorkspaceId);
      expect(created.taskId).toBe(
        encodeRemoteWorkspaceId(remoteServerId, `task-${remoteWorkspaceId}`)
      );

      const controller = new AbortController();

      try {
        const iterator = await client.workspace.backgroundBashes.subscribe(
          { workspaceId: encodedWorkspaceId },
          { signal: controller.signal }
        );

        const first = await iterator[Symbol.asyncIterator]().next();
        expect(first.done).toBe(false);
        expect(first.value).toEqual({ workspaceId: encodedWorkspaceId, event: "hello" });
      } finally {
        controller.abort();
      }

      // Remote handlers should have seen *decoded* IDs (no remote.* prefix).
      expect(remoteGetPlanInputs).toEqual([remoteWorkspaceId]);
      expect(remoteSubscribeInputs).toEqual([remoteWorkspaceId]);
      expect(remoteTaskCreateInputs).toEqual([remoteWorkspaceId]);
    } finally {
      await localServer?.close();
      await remoteServer?.close();
    }
  }, 20_000);
});
