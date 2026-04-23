{
  description = "mux - coder multiplexer";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          # package.json pins Electron 38.x, but nixpkgs marks that branch
          # end-of-life ("insecure"). Let any electron* package evaluate so
          # the devShell and production build keep working until we bump
          # Electron upstream in package.json.
          config.allowInsecurePredicate = attrs: builtins.match "electron.*" (attrs.pname or "") != null;
        };

        mux = pkgs.stdenv.mkDerivation rec {
          pname = "mux";
          version = self.rev or self.dirtyRev or "dev";

          src = ./.;

          nativeBuildInputs = with pkgs; [
            bun
            nodejs
            makeWrapper
            gnumake
            git # Needed by scripts/generate-version.sh
            python3 # Needed by node-gyp for native module builds
          ];

          buildInputs = with pkgs; [
            # Pin the major Electron version explicitly so `pkgs.electron`
            # floating to a new major doesn't silently ship the wrong
            # Node.js ABI for our prebuilt native modules.
            electron_38
            stdenv.cc.cc.lib # Provides libstdc++ for native modules like sharp
          ];

          # Fetch dependencies in a separate fixed-output derivation
          # Use only package.json and bun.lock to ensure consistent hashing
          # regardless of how the flake is evaluated (local vs remote)
          offlineCache = pkgs.stdenvNoCC.mkDerivation {
            name = "mux-deps-${version}";

            src = pkgs.runCommand "mux-lock-files" { } ''
              mkdir -p $out
              cp ${./package.json} $out/package.json
              cp ${./bun.lock} $out/bun.lock
            '';

            nativeBuildInputs = [
              pkgs.bun
              pkgs.cacert
            ];

            # Don't patch shebangs in node_modules - it creates /nix/store references
            dontPatchShebangs = true;
            dontFixup = true;

            # --ignore-scripts: postinstall scripts (e.g., lzma-native's node-gyp-build)
            # fail in the sandbox because shebangs like #!/usr/bin/env node can't resolve.
            # Native modules are rebuilt in the main derivation after patchShebangs runs.
            buildPhase = ''
              export HOME=$TMPDIR
              export BUN_INSTALL_CACHE_DIR=$TMPDIR/.bun-cache
              bun install --frozen-lockfile --no-progress --ignore-scripts
            '';

            installPhase = ''
              mkdir -p $out
              cp -r node_modules $out/
            '';

            outputHashMode = "recursive";
            # Marker used by scripts/update_flake_hash.sh to update this hash in place.
            outputHash = "sha256-WvzB3zFWrWA2mPCWIg/vVlDZbUFTWNTgL52TumiWvyM="; # mux-offline-cache-hash
          };

          configurePhase = ''
            export HOME=$TMPDIR
            # Use pre-fetched dependencies (copy so tools can write to it)
            cp -r ${offlineCache}/node_modules .
            chmod -R +w node_modules

            # Patch shebangs in node_modules binaries and scripts
            patchShebangs node_modules
            patchShebangs scripts

            # Run postinstall to rebuild node-pty for Electron
            # (skipped in offlineCache due to --ignore-scripts)
            ./scripts/postinstall.sh

            # Touch sentinel to prevent make from re-running bun install
            touch node_modules/.installed
          '';

          buildPhase = ''
            echo "Building mux with make..."
            export LD_LIBRARY_PATH="${pkgs.stdenv.cc.cc.lib}/lib:$LD_LIBRARY_PATH"
            make SHELL=${pkgs.bash}/bin/bash build
          '';

          installPhase = ''
                        mkdir -p $out/lib/mux
                        mkdir -p $out/bin

                        # Copy built files and runtime dependencies
                        cp -r dist $out/lib/mux/
                        cp -r node_modules $out/lib/mux/
                        cp package.json $out/lib/mux/

                        # Ensure vendored binaries have execute permission.
                        # agent-browser's postinstall normally does this, but
                        # --ignore-scripts in offlineCache skips it, and the
                        # Nix store is read-only at runtime so chmod is impossible.
                        chmod +x $out/lib/mux/node_modules/agent-browser/bin/* 2>/dev/null || true

                        # Create wrapper script. When running in Nix, mux doesn't know that
                        # it's packaged. Use MUX_E2E_LOAD_DIST to force using compiled
                        # assets instead of a dev server.
                        makeWrapper ${pkgs.electron_38}/bin/electron $out/bin/mux \
                          --add-flags "$out/lib/mux/dist/cli/index.js" \
                          --set MUX_E2E_LOAD_DIST "1" \
                          --prefix LD_LIBRARY_PATH : "${pkgs.stdenv.cc.cc.lib}/lib" \
                          --prefix PATH : ${
                            pkgs.lib.makeBinPath [
                              pkgs.git
                              pkgs.bash
                            ]
                          }

                        # Install desktop file and icon for launcher integration
                        install -Dm644 public/icon.png $out/share/icons/hicolor/512x512/apps/mux.png
                        mkdir -p $out/share/applications
                        cat > $out/share/applications/mux.desktop << EOF
            [Desktop Entry]
            Name=Mux
            GenericName=Agent Multiplexer
            Comment=Agent Multiplexer
            Exec=$out/bin/mux %U
            Icon=mux
            Terminal=false
            Type=Application
            Categories=Development;
            StartupWMClass=mux
            EOF
          '';

          meta = with pkgs.lib; {
            description = "mux - coder multiplexer";
            homepage = "https://github.com/coder/mux";
            license = licenses.agpl3Only;
            platforms = platforms.linux ++ platforms.darwin;
            mainProgram = "mux";
          };
        };
      in
      {
        packages.default = mux;
        packages.mux = mux;

        formatter = pkgs.nixfmt-rfc-style;

        apps.default = {
          type = "app";
          program = "${mux}/bin/mux";
        };

        devShells.default = pkgs.mkShell {
          buildInputs =
            with pkgs;
            [
              bun

              # Node + build tooling
              nodejs
              gnumake
              stdenv.cc.cc.lib # Provides libstdc++.so.6 for DuckDB native bindings under Bun

              # Common CLIs
              git
              bash

              # Nix tooling
              nixfmt-rfc-style

              # Repo linting (make static-check)
              go
              hadolint
              shellcheck
              shfmt
              gh
              jq
              duckdb

              # Documentation
              mdbook
              mdbook-mermaid
              mdbook-linkcheck
              mdbook-pagetoc

              # Terminal bench + browser recording
              uv
              asciinema
              ffmpeg
            ]
            ++ lib.optionals stdenv.isLinux [
              docker
              # The Electron binary shipped in node_modules/electron/dist
              # is dynamically linked against standard FHS paths
              # (libglib-2.0.so.0, libnss3.so, etc.) that don't exist on
              # NixOS, so `make start` / `make dev` fail with "error while
              # loading shared libraries". Expose Nix's autoPatchelf'd
              # Electron and redirect the npm wrapper to it via
              # ELECTRON_OVERRIDE_DIST_PATH below.
              electron_38
            ];

          # Bun does not carry libstdc++ on Linux, so native modules like @duckdb/node-bindings
          # fail to dlopen during tests unless we expose the GCC runtime in the shell.
          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ];

          # Point `node_modules/electron/cli.js` at the Nix-patched Electron
          # binary on Linux so `bunx electron` (used by `make start`/`make dev`)
          # finds its shared libraries on NixOS without needing an FHS wrapper.
          # Left unset on Darwin where the npm-shipped binary runs as-is.
          ELECTRON_OVERRIDE_DIST_PATH = pkgs.lib.optionalString pkgs.stdenv.isLinux "${pkgs.electron_38}/libexec/electron";
        };
      }
    );
}
