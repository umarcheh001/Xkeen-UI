#!/bin/sh

ARCHIVE_URL="https://github.com/umarcheh001/Xkeen-UI/releases/download/v1.0.0/xkeen-ui-routing.tar.gz"
ARCHIVE_NAME="xkeen-ui-routing.tar.gz"

echo "=== Xkeen-UI: установка из релиза GitHub ==="

# Проверяем, что есть /opt (Entware)
if [ ! -d /opt ]; then
    echo "Ошибка: каталог /opt не найден (Entware не смонтирован)."
    exit 1
fi

cd /opt || exit 1

# Проверяем, что есть curl
if ! command -v curl >/dev/null 2>&1; then
    echo "Ошибка: не найден curl. Установи curl в Entware (opkg install curl)."
    exit 1
fi

echo "[*] Скачиваю архив панели..."
if ! curl -L -o "$ARCHIVE_NAME" "$ARCHIVE_URL"; then
    echo "Ошибка скачивания архива."
    exit 1
fi

echo "[*] Распаковка архива..."
if ! tar -xzf "$ARCHIVE_NAME"; then
    echo "Ошибка распаковки архива."
    exit 1
fi

# В архиве у тебя папка xkeen-ui
if [ -d xkeen-ui ]; then
    cd xkeen-ui || exit 1
else
    echo "Каталог xkeen-ui не найден после распаковки."
    exit 1
fi

if [ ! -f install.sh ]; then
    echo "install.sh не найден в каталоге xkeen-ui."
    exit 1
fi

echo "[*] Запускаю install.sh..."
sh install.sh

echo "=== Установка Xkeen-UI завершена ==="
