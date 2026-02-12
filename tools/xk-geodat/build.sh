#!/usr/bin/env bash
set -euo pipefail

# Build helper for xk-geodat.
# Usage:
#   ./build.sh                 # builds for current host
#   GOOS=linux GOARCH=mipsle ./build.sh
#   OUT=./xk-geodat-mipsle ./build.sh

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${OUT:-$HERE/xk-geodat}"

export CGO_ENABLED=0

echo "[*] Building to: $OUT"
go build -trimpath -ldflags "-s -w" -o "$OUT" ./cmd/xk-geodat

file "$OUT" || true
