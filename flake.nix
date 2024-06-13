# SPDX-FileCopyrightText: 2024 LiveKit, Inc.
#
# SPDX-License-Identifier: Apache-2.0

{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, utils, nixpkgs }:
    utils.lib.eachDefaultSystem (system:
      let pkgs = (import nixpkgs) {
        inherit system;
      };

      in {
        devShell = with pkgs; mkShell {
          nativeBuildInputs = [ nodejs corepack reuse turbo ];
          LD_LIBRARY_PATH = "${pkgs.stdenv.cc.cc.lib}/lib/";
        };
      }
    );
}
