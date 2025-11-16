#!/usr/bin/env node

const isServer = process.argv.length > 2 && process.argv[2] === "server";

if (isServer) {
  // Remove 'server' from args since main-server doesn't expect it as a positional argument.
  process.argv.splice(2, 1);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("./server");
} else {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../desktop/main");
}
