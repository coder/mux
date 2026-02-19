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
            electron
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
            outputHash = "sha256-+6o2twg8KOUBuq2RoEqY/OwqCnWSrUiXFuaeLUiuF3k="; # mux-offline-cache-hash
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

                        # Create wrapper script. When running in Nix, mux doesn't know that
                        # it's packaged. Use MUX_E2E_LOAD_DIST to force using compiled
                        # assets instead of a dev server.
                        makeWrapper ${pkgs.electron}/bin/electron $out/bin/mux \
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

              # Common CLIs
              git
              bash

              # Nix tooling
              nixfmt-rfc-style

              # Repo linting (make static-check)
              go
              shellcheck
              shfmt
              gh
              jq

              # Documentation
              mdbook
              mdbook-mermaid
              mdbook-linkcheck
              mdbook-pagetoc

              # Terminal bench
              uv
              asciinema
            ]
            ++ lib.optionals stdenv.isLinux [ docker ];
        };
      }
    );
}
