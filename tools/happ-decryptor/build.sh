#!/usr/bin/env bash
set -euo pipefail

# Build helper for happ-decrypt-universal.
# Usage:
#   ./build.sh                                   # builds for current host
#   GOOS=linux GOARCH=arm64 ./build.sh
#   GOOS=linux GOARCH=mipsle GOMIPS=softfloat OUT=./happ-decrypt-universal-mipsle ./build.sh

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${OUT:-$HERE/happ-decrypt-universal}"
cd "$HERE"

export CGO_ENABLED=0

# Optional build metadata (for -version)
VERSION=${VERSION:-$(git describe --tags --always 2>/dev/null || echo "dev")}
COMMIT=${COMMIT:-$(git rev-parse --short HEAD 2>/dev/null || echo "")}
DATE=${DATE:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
LDFLAGS=${LDFLAGS:-"-s -w -X main.version=${VERSION} -X main.commit=${COMMIT} -X main.date=${DATE}"}

echo "[*] Building to: $OUT"
go build -trimpath -ldflags "${LDFLAGS}" -o "$OUT" ./cmd/happ-decrypt-universal

file "$OUT" || true
