#!/bin/sh
set -eu

REPO="umarcheh001/Xkeen-UI"

# Where to install the binary. Backend/UI may override this via XKEEN_GEODAT_BIN.
DEST_DEFAULT="/opt/etc/xkeen-ui/bin/xk-geodat"
DEST="${XKEEN_GEODAT_BIN:-$DEST_DEFAULT}"
DEST_DIR="$(dirname "$DEST")"

# Some Go binaries built with newer Go versions may refuse to run on older
# kernels without an explicit opt-in env var.
#
# The panel backend (_geodat_run_help) already knows how to detect this message
# and retry with ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH=goX.Y.
#
# This installer also runs "--help" as a sanity check to validate the binary.
# Without the retry logic, a perfectly fine xk-geodat might be treated as
# "bad" and deleted, making "install from file" fail while manual copy works.

geodat_sanity_check() {
  BIN="$1"

  # We need the exit code + output, so temporarily disable "set -e".
  set +e
  OUT="$($BIN --help 2>&1)"
  RC=$?
  set -e

  # Success.
  if [ "$RC" -eq 0 ]; then
    return 0
  fi

  # Retry when Go runtime requests ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH.
  if echo "$OUT" | grep -q "ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH="; then
    VER="$(echo "$OUT" | sed -n 's/.*ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH=\(go[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n1)"
    if [ -n "$VER" ]; then
      set +e
      OUT2="$(ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH="$VER" $BIN --help 2>&1)"
      RC2=$?
      set -e

      # Hard failures (wrong arch / missing loader / noexec, etc.).
      if [ "$RC2" -eq 126 ] || [ "$RC2" -eq 127 ] || echo "$OUT2" | grep -qi -e "Exec format error" -e "not found"; then
        return 1
      fi
      # Any other non-zero is considered acceptable (some builds exit non-zero on --help).
      return 0
    fi
  fi

  # Hard failures.
  if [ "$RC" -eq 126 ] || [ "$RC" -eq 127 ] || echo "$OUT" | grep -qi -e "Exec format error" -e "not found"; then
    return 1
  fi

  # Non-fatal (treat as OK).
  return 0
}

# Backup/restore helpers (never fail the outer installer).
BAK=""
backup_existing() {
  BAK=""
  if [ -f "$DEST" ]; then
    TS="$(date +%Y%m%d-%H%M%S 2>/dev/null || echo $$)"
    BAK="${DEST}.bak-${TS}"
    echo "xk-geodat: backup existing -> $BAK"
    mv "$DEST" "$BAK" || { echo "xk-geodat: backup failed — пропуск"; exit 0; }
  fi
}
restore_backup() {
  if [ -n "$BAK" ] && [ -f "$BAK" ]; then
    mv "$BAK" "$DEST" 2>/dev/null || true
  fi
}

have_hash_tool() {
  command -v sha256sum >/dev/null 2>&1 && return 0
  command -v openssl >/dev/null 2>&1 && return 0
  command -v shasum >/dev/null 2>&1 && return 0
  return 1
}

file_sha256() {
  F="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$F" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    # openssl dgst -sha256 file  => "SHA256(file)= <hash>"
    openssl dgst -sha256 "$F" | awk '{print $NF}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$F" | awk '{print $1}'
  else
    return 1
  fi
}

fetch_url() {
  URL="$1"
  OUT="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fL -o "$OUT" "$URL"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$OUT" "$URL"
  else
    return 127
  fi
}

verify_sha256sums_if_available() {
  BIN_FILE="$1"
  ASSET_NAME="$2"
  SUMS_URL="$3"
  SUMS_TMP="$4"

  # Try to download SHA256SUMS. If not available — warn and continue (soft).
  if ! fetch_url "$SUMS_URL" "$SUMS_TMP" 2>/dev/null; then
    echo "xk-geodat: SHA256SUMS not available — continue"
    rm -f "$SUMS_TMP" 2>/dev/null || true
    return 0
  fi

  if ! have_hash_tool; then
    echo "xk-geodat: sha256 tool not found — skip checksum"
    rm -f "$SUMS_TMP" 2>/dev/null || true
    return 0
  fi

  # sha256sum format: "<hash>  <file>" or "<hash> *<file>"
  EXPECTED="$(grep -E "[[:space:]\*]${ASSET_NAME}\$" "$SUMS_TMP" | awk '{print $1}' | head -n1 || true)"
  if [ -z "$EXPECTED" ]; then
    echo "xk-geodat: SHA256SUMS missing entry for $ASSET_NAME — continue"
    rm -f "$SUMS_TMP" 2>/dev/null || true
    return 0
  fi

  ACTUAL="$(file_sha256 "$BIN_FILE" 2>/dev/null || true)"
  if [ -z "$ACTUAL" ]; then
    echo "xk-geodat: failed to compute sha256 — continue"
    rm -f "$SUMS_TMP" 2>/dev/null || true
    return 0
  fi

  if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "xk-geodat: SHA256 mismatch for $ASSET_NAME"
    echo "  expected: $EXPECTED"
    echo "  actual:   $ACTUAL"
    rm -f "$SUMS_TMP" 2>/dev/null || true
    return 1
  fi

  echo "xk-geodat: SHA256 OK"
  rm -f "$SUMS_TMP" 2>/dev/null || true
  return 0
}

# Control:
#   XKEEN_GEODAT_INSTALL=1  -> install without asking
#   XKEEN_GEODAT_INSTALL=0  -> skip
#   (unset) -> ask if TTY, else try install (non-blocking)
INSTALL="${XKEEN_GEODAT_INSTALL:-}"

# Ask user only in interactive terminal
if [ -z "$INSTALL" ] && [ -t 0 ]; then
  echo ""
  echo "Установить xk-geodat (включит 'Содержимое' и 'В routing' для DAT GeoIP/GeoSite)?"
  printf "Введите Y/n: "
  read ans || ans=""
  case "$ans" in
    n|N|no|NO) INSTALL="0" ;;
    *)         INSTALL="1" ;;
  esac
fi

# Non-interactive default: try install (but never fail install.sh)
if [ -z "$INSTALL" ]; then
  INSTALL="1"
fi

[ "$INSTALL" = "1" ] || { echo "xk-geodat: пропущено"; exit 0; }

mkdir -p "$DEST_DIR"

ARCH="$(uname -m 2>/dev/null || echo unknown)"
OPKG_ARCH=""
if command -v opkg >/dev/null 2>&1; then
  OPKG_ARCH="$(opkg print-architecture 2>/dev/null | awk 'NR==1{print $2}' || true)"
fi

ASSET=""
case "${ARCH}/${OPKG_ARCH}" in
  *aarch64*|*arm64*) ASSET="xk-geodat-linux-arm64" ;;
  *mips*/*mipsel*|*mips*/*mipsle*|*mipsel*|*mipsle*) ASSET="xk-geodat-linux-mipsle" ;;
  *) echo "xk-geodat: unsupported arch: $ARCH ($OPKG_ARCH) — пропуск"; exit 0 ;;
esac

# Optional overrides (useful for testing before publishing a Release):
#   XKEEN_GEODAT_ASSET         -> override asset name (default is detected by arch)
#   XKEEN_GEODAT_TAG           -> download from a specific GitHub release tag (instead of latest)
#   XKEEN_GEODAT_URL           -> full URL to binary (overrides TAG/latest logic)
#   XKEEN_GEODAT_LOCAL         -> install from an existing local file (skip download)
#   XKEEN_GEODAT_SHA256SUMS_URL-> override URL to SHA256SUMS
if [ -n "${XKEEN_GEODAT_ASSET:-}" ]; then
  ASSET="$XKEEN_GEODAT_ASSET"
fi

if [ -n "${XKEEN_GEODAT_LOCAL:-}" ] && [ -f "$XKEEN_GEODAT_LOCAL" ]; then
  echo "xk-geodat: installing from local file $XKEEN_GEODAT_LOCAL"
  backup_existing
  cp "$XKEEN_GEODAT_LOCAL" "$DEST" || { echo "xk-geodat: copy failed — пропуск"; restore_backup; exit 0; }
  chmod +x "$DEST" || { echo "xk-geodat: chmod failed — пропуск"; restore_backup; exit 0; }
  geodat_sanity_check "$DEST" || { echo "xk-geodat: bad local binary — пропуск"; rm -f "$DEST"; restore_backup; exit 0; }
  echo "xk-geodat: installed to $DEST"
  exit 0
fi

BASE=""
if [ -n "${XKEEN_GEODAT_URL:-}" ]; then
  URL="$XKEEN_GEODAT_URL"
elif [ -n "${XKEEN_GEODAT_TAG:-}" ]; then
  BASE="https://github.com/$REPO/releases/download/$XKEEN_GEODAT_TAG/"
  URL="${BASE}${ASSET}"
else
  BASE="https://github.com/$REPO/releases/latest/download/"
  URL="${BASE}${ASSET}"
fi

TMP="/tmp/$ASSET.$$"
SUMS_TMP="/tmp/SHA256SUMS.$$"

echo "xk-geodat: downloading $URL"

# Download the binary (never fail the outer installer).
set +e
fetch_url "$URL" "$TMP"
RC=$?
set -e
if [ "$RC" -ne 0 ]; then
  if [ "$RC" -eq 127 ]; then
    echo "xk-geodat: curl/wget not found — пропуск"
  else
    echo "xk-geodat: download failed — пропуск"
  fi
  rm -f "$TMP" 2>/dev/null || true
  exit 0
fi

chmod +x "$TMP"

# Soft checksum verification (if SHA256SUMS is available)
if [ -n "${XKEEN_GEODAT_SHA256SUMS_URL:-}" ]; then
  SUMS_URL="$XKEEN_GEODAT_SHA256SUMS_URL"
elif [ -n "$BASE" ]; then
  SUMS_URL="${BASE}SHA256SUMS"
else
  SUMS_URL="${URL%/*}/SHA256SUMS"
fi

verify_sha256sums_if_available "$TMP" "$ASSET" "$SUMS_URL" "$SUMS_TMP" || { echo "xk-geodat: checksum failed — пропуск"; rm -f "$TMP"; exit 0; }

# sanity check
geodat_sanity_check "$TMP" || { echo "xk-geodat: bad binary — пропуск"; rm -f "$TMP"; exit 0; }

backup_existing
if mv "$TMP" "$DEST"; then
  echo "xk-geodat: installed to $DEST"
else
  echo "xk-geodat: install failed — пропуск"
  rm -f "$TMP" 2>/dev/null || true
  restore_backup
fi
