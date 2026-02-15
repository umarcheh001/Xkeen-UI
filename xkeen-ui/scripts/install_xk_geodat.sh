#!/bin/sh
set -eu

REPO="umarcheh001/Xkeen-UI"
DEST_DIR="/opt/etc/xkeen-ui/bin"
DEST="$DEST_DIR/xk-geodat"

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
#   XKEEN_GEODAT_ASSET  -> override asset name (default is detected by arch)
#   XKEEN_GEODAT_TAG    -> download from a specific GitHub release tag (instead of latest)
#   XKEEN_GEODAT_URL    -> full URL to binary (overrides TAG/latest logic)
#   XKEEN_GEODAT_LOCAL  -> install from an existing local file (skip download)
if [ -n "${XKEEN_GEODAT_ASSET:-}" ]; then
  ASSET="$XKEEN_GEODAT_ASSET"
fi

if [ -n "${XKEEN_GEODAT_LOCAL:-}" ] && [ -f "$XKEEN_GEODAT_LOCAL" ]; then
  echo "xk-geodat: installing from local file $XKEEN_GEODAT_LOCAL"
  cp "$XKEEN_GEODAT_LOCAL" "$DEST"
  chmod +x "$DEST"
  geodat_sanity_check "$DEST" || { echo "xk-geodat: bad local binary — пропуск"; rm -f "$DEST"; exit 0; }
  echo "xk-geodat: installed to $DEST"
  exit 0
fi

if [ -n "${XKEEN_GEODAT_URL:-}" ]; then
  URL="$XKEEN_GEODAT_URL"
elif [ -n "${XKEEN_GEODAT_TAG:-}" ]; then
  URL="https://github.com/$REPO/releases/download/$XKEEN_GEODAT_TAG/$ASSET"
else
  URL="https://github.com/$REPO/releases/latest/download/$ASSET"
fi
TMP="/tmp/$ASSET.$$"

echo "xk-geodat: downloading $URL"

if command -v curl >/dev/null 2>&1; then
  curl -fL -o "$TMP" "$URL" || { echo "xk-geodat: download failed — пропуск"; exit 0; }
elif command -v wget >/dev/null 2>&1; then
  wget -O "$TMP" "$URL" || { echo "xk-geodat: download failed — пропуск"; exit 0; }
else
  echo "xk-geodat: curl/wget not found — пропуск"
  exit 0
fi

chmod +x "$TMP"

# sanity check
geodat_sanity_check "$TMP" || { echo "xk-geodat: bad binary — пропуск"; rm -f "$TMP"; exit 0; }

mv "$TMP" "$DEST"
echo "xk-geodat: installed to $DEST"
