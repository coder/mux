#!/usr/bin/env node

import { Command } from "commander";
import { VERSION } from "../version";
import { createCli } from "trpc-cli";
import { router } from "@/node/orpc/router";
import { Config } from "@/node/config";
import { ServiceContainer } from "@/node/services/serviceContainer";
import { migrateLegacyMuxHome } from "@/common/constants/paths";
import type { BrowserWindow } from "electron";
import type { ORPCContext } from "@/node/orpc/context";

// Minimal BrowserWindow stub for services that expect one (same as server.ts)
const mockWindow: BrowserWindow = {
  isDestroyed: () => false,
  setTitle: () => undefined,
  webContents: {
    send: () => undefined,
    openDevTools: () => undefined,
  },
} as unknown as BrowserWindow;

async function createServiceContext(): Promise<ORPCContext> {
  migrateLegacyMuxHome();

  const config = new Config();
  const serviceContainer = new ServiceContainer(config);
  await serviceContainer.initialize();
  serviceContainer.windowService.setMainWindow(mockWindow);

  return {
    projectService: serviceContainer.projectService,
    workspaceService: serviceContainer.workspaceService,
    providerService: serviceContainer.providerService,
    terminalService: serviceContainer.terminalService,
    windowService: serviceContainer.windowService,
    updateService: serviceContainer.updateService,
    tokenizerService: serviceContainer.tokenizerService,
    serverService: serviceContainer.serverService,
    menuEventService: serviceContainer.menuEventService,
  };
}

async function main() {
  const program = new Command();

  program
    .name("mux")
    .description("mux - coder multiplexer")
    .version(`mux ${VERSION.git_describe} (${VERSION.git_commit})`, "-v, --version");

  program
    .command("server")
    .description("Start the HTTP/WebSocket oRPC server")
    .allowUnknownOption() // server.ts handles its own options via commander
    .action(() => {
      // Remove 'server' from args since server.ts has its own commander instance
      process.argv.splice(2, 1);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("./server");
    });

  program
    .command("version")
    .description("Show version information")
    .action(() => {
      console.log(`mux ${VERSION.git_describe} (${VERSION.git_commit})`);
    });

  // Only initialize services if the 'api' subcommand is being used
  if (process.argv[2] === "api") {
    const context = await createServiceContext();
    program.addCommand(
      (createCli({ router: router(), context }).buildProgram() as Command)
        .name("api")
        .description("Interact with the oRPC API directly")
    );
  }

  // Default action: launch desktop app when no subcommand given
  program.action(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("../desktop/main");
  });

  program.parse();
}

main().catch((error) => {
  console.error("CLI initialization failed:", error);
  process.exit(1);
});
