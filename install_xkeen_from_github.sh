#!/bin/sh
set -e

REPO_OWNER="umarcheh001"
REPO_NAME="Xkeen-UI"
BRANCH="main"

ARCHIVE_NAME="xkeen-ui-routing.tar.gz" 

INSTALL_DIR="/opt"

echo "=== Xkeen-UI: установка из GitHub ==="

# Проверка Entware
if [ ! -d "$INSTALL_DIR" ]; then
    echo "/opt отсутствует — установи Entware."
    exit 1
fi

cd "$INSTALL_DIR"

# Выбор загрузчика
if command -v wget >/dev/null; then
    DL="wget -O"
elif command -v curl >/dev/null; then
    DL="curl -L -o"
else
    echo "Нужен wget или curl"
    exit 1
fi

URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/raw/${BRANCH}/${ARCHIVE_NAME}"

echo "[*] Скачиваю архив: $URL"
$DL "$ARCHIVE_NAME" "$URL"

echo "[*] Распаковка..."
TOP_DIR=$(tar -tzf "$ARCHIVE_NAME" | head -n 1 | cut -d/ -f1)
tar -xzf "$ARCHIVE_NAME"

cd "$TOP_DIR"

# Вложенная директория panel?
if [ -d "xkeen-ui" ]; then
    cd xkeen-ui
fi

if [ ! -f "install.sh" ]; then
    echo "install.sh не найден!"
    exit 1
fi

echo "[*] Запуск install.sh..."
sh install.sh

echo "=== Установка Xkeen-UI завершена ==="
