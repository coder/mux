/**
 * API CLI subcommand - delegates to a running mux server via HTTP.
 *
 * This module is loaded lazily to avoid pulling in ESM-only dependencies
 * (trpc-cli) when running other commands like the desktop app.
 */

import { createCli } from "trpc-cli";
import { router } from "@/node/orpc/router";
import { proxifyOrpc } from "./proxifyOrpc";
import type { Command } from "commander";

const baseUrl = process.env.MUX_SERVER_URL ?? "http://localhost:3000";
const authToken = process.env.MUX_SERVER_AUTH_TOKEN;

const proxiedRouter = proxifyOrpc(router(), { baseUrl, authToken });
const cli = createCli({ router: proxiedRouter }).buildProgram() as Command;

cli.name("mux api");
cli.description("Interact with the mux API via a running server");
cli.parse();
