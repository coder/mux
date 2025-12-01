/**
 * API CLI subcommand - delegates to a running mux server via HTTP.
 *
 * This module is loaded lazily to avoid pulling in ESM-only dependencies
 * (trpc-cli) when running other commands like the desktop app.
 */

import { createCli } from "trpc-cli";
import { router } from "@/node/orpc/router";
import { proxifyOrpc } from "./proxifyOrpc";
import { Command } from "commander";

export async function runApiCli(parent: Command): Promise<void> {
  const baseUrl = process.env.MUX_SERVER_URL ?? "http://localhost:3000";
  const authToken = process.env.MUX_AUTH_TOKEN;

  const proxiedRouter = proxifyOrpc(router(), { baseUrl, authToken });
  const cli = createCli({ router: proxiedRouter }).buildProgram() as Command;

  cli.name("api");
  cli.description("Interact with the oRPC API via a running server");
  cli.parent = parent;
  cli.parse();
}
