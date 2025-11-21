#!/bin/sh
set -e

INSTALL_ROOT="/opt"
TARBALL_NAME="xkeen-ui-routing.tar.gz"
RELEASE_URL="https://github.com/umarcheh001/Xkeen-UI/releases/download/v1.0.4/xkeen-ui-routing.tar.gz"

echo "=== Xkeen UI: онлайн-установка из GitHub ==="

[ -d "$INSTALL_ROOT" ] || { echo "[!] Каталог $INSTALL_ROOT не найден"; exit 1; }

cd "$INSTALL_ROOT"

if command -v curl >/dev/null 2>&1; then
  DOWNLOADER="curl -fSL"
elif command -v wget >/dev/null 2>&1; then
  DOWNLOADER="wget -O"
else
  echo "[!] Не найден ни curl, ни wget. Установи через Entware: opkg install curl"
  exit 1
fi

echo "[*] Скачиваю архив:"
echo " $RELEASE_URL"
if echo "$DOWNLOADER" | grep -q curl; then
  $DOWNLOADER "$RELEASE_URL" -o "$TARBALL_NAME"
else
  $DOWNLOADER "$TARBALL_NAME" "$RELEASE_URL"
fi

echo "[*] Распаковываю архив..."
tar -xzf "$TARBALL_NAME"

cd xkeen-ui
echo "[*] Запускаю install.sh..."
sh install.sh

cd "$INSTALL_ROOT"
echo "[*] Очищаю установочный архив..."
rm -f "$TARBALL_NAME" || true

echo "=== Установка Xkeen UI завершена ==="
