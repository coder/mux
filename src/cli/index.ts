#!/usr/bin/env node

import { Command } from "commander";
import { VERSION } from "../version";

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

// Default action: launch desktop app when no subcommand given
program.action(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../desktop/main");
});

program.parse();
