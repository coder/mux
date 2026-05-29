import { createORPCClient } from "@orpc/client";
import type { ClientContext, ClientLink } from "@orpc/client";
import type { AppRouter } from "@/node/orpc/router";
import type { RouterClient } from "@orpc/server";

export function createClient(link: ClientLink<ClientContext>): RouterClient<AppRouter> {
  return createORPCClient(link);
}
