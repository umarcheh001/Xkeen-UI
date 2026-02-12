#!/bin/sh
set -eu

REPO="umarcheh001/Xkeen-UI"
DEST_DIR="/opt/etc/xkeen-ui/bin"
DEST="$DEST_DIR/xk-geodat"

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

URL="https://github.com/$REPO/releases/latest/download/$ASSET"
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
"$TMP" --help >/dev/null 2>&1 || { echo "xk-geodat: bad binary — пропуск"; rm -f "$TMP"; exit 0; }

mv "$TMP" "$DEST"
echo "xk-geodat: installed to $DEST"
