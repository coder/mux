import { createRouterClient, type RouterClient } from "@orpc/server";
import { router, type AppRouter } from "@/node/orpc/router";
import type { ORPCContext } from "@/node/orpc/context";

export type OrpcTestClient = RouterClient<AppRouter>;

export function createOrpcTestClient(context: ORPCContext): OrpcTestClient {
  return createRouterClient(router(), { context });
}
