#!/usr/bin/env node

import { Command } from "commander";
import { VERSION } from "../version";

<<<<<<< HEAD
const program = new Command();

program
  .name("mux")
  .description("mux - coder multiplexer")
  .version(`mux ${VERSION.git_describe} (${VERSION.git_commit})`, "-v, --version");

// Subcommands with their own CLI parsers - disable help interception so --help passes through
program
  .command("server")
  .description("Start the HTTP/WebSocket oRPC server")
  .helpOption(false)
  .allowUnknownOption()
  .allowExcessArguments()
  .action(() => {
    process.argv.splice(2, 1);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("./server");
  });

program
  .command("api")
  .description("Interact with the mux API via a running server")
  .helpOption(false)
  .allowUnknownOption()
  .allowExcessArguments()
  .action(() => {
    process.argv.splice(2, 1);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("./api");
  });

program
  .command("version")
  .description("Show version information")
  .action(() => {
    console.log(`mux ${VERSION.git_describe} (${VERSION.git_commit})`);
  });

// Default action: launch desktop app when no subcommand given
program.action(() => {
||||||| parent of 0f258d5fc (🤖 feat: add first-class `mux run` CLI command)
if (subcommand === "server") {
  // Remove 'server' from args since main-server doesn't expect it as a positional argument.
  process.argv.splice(2, 1);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("./server");
} else if (subcommand === "version") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { VERSION } = require("../version") as {
    VERSION: { git_describe: string; git_commit: string };
  };
  console.log(`mux ${VERSION.git_describe} (${VERSION.git_commit})`);
} else {
=======
if (subcommand === "server") {
  // Remove 'server' from args since main-server doesn't expect it as a positional argument.
  process.argv.splice(2, 1);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("./server");
} else if (subcommand === "run") {
  // Remove 'run' from args since run.ts uses Commander which handles its own parsing
  process.argv.splice(2, 1);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("./run");
} else if (subcommand === "version") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { VERSION } = require("../version") as {
    VERSION: { git_describe: string; git_commit: string };
  };
  console.log(`mux ${VERSION.git_describe} (${VERSION.git_commit})`);
} else {
>>>>>>> 0f258d5fc (🤖 feat: add first-class `mux run` CLI command)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../desktop/main");
});

program.parse();
