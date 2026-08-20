#!/usr/bin/env node

// Keep the published `mux` package as a tiny forwarding boundary. The implementation
// stays entirely in `shux`, so the compatibility package can be retired without
// leaving duplicate CLI logic behind.
require("shux/dist/cli/index.js");
