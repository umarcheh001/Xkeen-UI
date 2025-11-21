#!/bin/sh
set -e

REPO="umarcheh001/Xkeen-UI"
INSTALL_ROOT="/opt"
TARBALL_NAME="xkeen-ui-latest.tar.gz"

echo "=== Xkeen UI: онлайн-установка из GitHub ==="

# Проверка /opt
if [ ! -d "$INSTALL_ROOT" ]; then
  echo "[!] Каталог $INSTALL_ROOT не найден. Нужен Entware."
  exit 1
fi

# Бинарники curl/wget
if command -v curl >/dev/null 2>&1; then
  HAVE_CURL=1
elif command -v wget >/dev/null 2>&1; then
  HAVE_WGET=1
else
  echo "[!] Не найден ни curl, ни wget. Установи один из них через Entware:"
  echo "    opkg update && opkg install curl"
  exit 1
fi

cd "$INSTALL_ROOT"

echo "[*] Получаю URL последнего релиза Xkeen-UI..."
URL=$(
  curl -s "https://api.github.com/repos/$REPO/releases/latest" \
  | grep browser_download_url \
  | grep '.tar.gz"' \
  | head -n 1 \
  | cut -d '"' -f 4
)

if [ -z "$URL" ]; then
  echo "[!] Не удалось найти .tar.gz в последнем релизе $REPO"
  exit 1
fi

echo "[*] Скачиваю архив:"
echo "    $URL"

if [ "$HAVE_CURL" = "1" ]; then
  curl -fSL "$URL" -o "$TARBALL_NAME"
else
  wget -O "$TARBALL_NAME" "$URL"
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
