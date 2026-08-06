#!/usr/bin/env bash
# Build the program and publish its IDL to the repo-root `idl/` directory, which is where
# the indexer's decoder generator and the dashboard both read from.
set -euo pipefail

PROGRAM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$PROGRAM_DIR/.." && pwd)"

# Solana 2.1's bundled cargo predates edition 2024 and cannot parse parts of the anchor-spl
# dependency tree. Prefer a newer release if one is installed alongside it.
for candidate in "$HOME"/.local/share/solana/install/releases/*/solana-release/bin; do
  version="$("$candidate/solana" --version 2>/dev/null | awk '{print $2}')" || continue
  case "$version" in
    2.1.*|2.0.*|1.*) continue ;;
  esac
  export PATH="$candidate:$PATH"
  break
done

echo "Using $(solana --version)"

cd "$PROGRAM_DIR"
anchor build

mkdir -p "$ROOT_DIR/idl"
cp target/idl/points_vault.json "$ROOT_DIR/idl/points_vault.json"
cp target/types/points_vault.ts "$ROOT_DIR/idl/points_vault.ts"

echo "IDL published to $ROOT_DIR/idl/"
