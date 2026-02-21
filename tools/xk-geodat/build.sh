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

# Optional build metadata (for --version)
VERSION=${VERSION:-$(git describe --tags --always 2>/dev/null || echo "dev")}
COMMIT=${COMMIT:-$(git rev-parse --short HEAD 2>/dev/null || echo "")}
DATE=${DATE:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
LDFLAGS=${LDFLAGS:-"-s -w -X main.version=${VERSION} -X main.commit=${COMMIT} -X main.date=${DATE}"}

echo "[*] Building to: $OUT"
go build -trimpath -ldflags "${LDFLAGS}" -o "$OUT" ./cmd/xk-geodat

file "$OUT" || true
