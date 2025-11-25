#!/usr/bin/env node

const subcommand = process.argv.length > 2 ? process.argv[2] : null;

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
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../desktop/main");
}
