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
          ];

          buildInputs = with pkgs; [
            electron
          ];

          # Fetch dependencies in a separate fixed-output derivation
          offlineCache = pkgs.stdenvNoCC.mkDerivation {
            name = "mux-deps-${version}";

            inherit src;

            nativeBuildInputs = [
              pkgs.bun
              pkgs.cacert
            ];

            # Don't patch shebangs in node_modules - it creates /nix/store references
            dontPatchShebangs = true;
            dontFixup = true;

            buildPhase = ''
              export HOME=$TMPDIR
              export BUN_INSTALL_CACHE_DIR=$TMPDIR/.bun-cache
              bun install --frozen-lockfile --no-progress
            '';

            installPhase = ''
              mkdir -p $out
              cp -r node_modules $out/
            '';

            outputHashMode = "recursive";
            outputHash = "sha256-doqJkN6tmwc/4ENop2E45EeFNJ2PWw2LdR1w1MgXW7k=";
          };

          configurePhase = ''
            export HOME=$TMPDIR
            # Use pre-fetched dependencies (copy so tools can write to it)
            cp -r ${offlineCache}/node_modules .
            chmod -R +w node_modules

            # Patch shebangs in node_modules binaries and scripts
            patchShebangs node_modules
            patchShebangs scripts
          '';

          buildPhase = ''
            echo "Building mux with make..."
            make build
          '';

          installPhase = ''
            mkdir -p $out/lib/mux
            mkdir -p $out/bin

            # Copy built files and runtime dependencies
            cp -r dist $out/lib/mux/
            cp -r node_modules $out/lib/mux/
            cp package.json $out/lib/mux/

            # Create wrapper script
            makeWrapper ${pkgs.electron}/bin/electron $out/bin/mux \
              --add-flags "$out/lib/mux/dist/main.js" \
              --prefix PATH : ${
                pkgs.lib.makeBinPath [
                  pkgs.git
                  pkgs.bash
                ]
              }
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
          buildInputs = with pkgs; [
            bun
            git
            bash
            nixfmt-rfc-style

            # Documentation
            mdbook
            mdbook-mermaid
            mdbook-linkcheck
            mdbook-pagetoc

            # Terminal bench
            uv
            asciinema
          ];
        };
      }
    );
}
