#!/bin/sh
set -e

ARCHIVE_URL="https://github.com/umarcheh001/Xkeen-UI/releases/download/v1.0.0/xkeen-ui-routing.tar.gz"
ARCHIVE_NAME="xkeen-ui-routing.tar.gz"

echo "=== Xkeen-UI: установка из релиза GitHub ==="

# Entware
cd /opt || { echo "Нет /opt – нужна установленная Entware"; exit 1; }

# Качаем архив любым доступным качальщиком
if command -v wget >/dev/null 2>&1; then
    echo "[*] Скачиваю архив через wget..."
    wget -O "$ARCHIVE_NAME" "$ARCHIVE_URL"
elif command -v curl >/dev/null 2>&1; then
    echo "[*] Скачиваю архив через curl..."
    curl -L -o "$ARCHIVE_NAME" "$ARCHIVE_URL"
else
    echo "Нужен wget или curl (как минимум один из них)."
    exit 1
fi

echo "[*] Распаковка архива..."
tar -xzf "$ARCHIVE_NAME"

echo "[*] Перехожу в каталог xkeen-ui..."
cd xkeen-ui

if [ ! -f install.sh ]; then
    echo "install.sh не найден в ./xkeen-ui"
    exit 1
fi

echo "[*] Запуск install.sh..."
sh install.sh

echo "=== Установка Xkeen-UI завершена ==="
