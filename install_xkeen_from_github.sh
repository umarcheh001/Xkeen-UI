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

echo "[*] Скачиваю архив панели..."

if command -v curl >/dev/null 2>&1; then
    curl -L -o "$ARCHIVE_NAME" "$ARCHIVE_URL" || {
        echo "Ошибка скачивания через curl."
        exit 1
    }
elif command -v wget >/dev/null 2>&1; then
    # На некоторых роутерах wget не умеет https — тогда тоже упадём
    wget -O "$ARCHIVE_NAME" "$ARCHIVE_URL" || {
        echo "Ошибка скачивания через wget."
        exit 1
    }
else
    echo "Нужен curl или wget для загрузки."
    exit 1
fi

echo "[*] Распаковка архива..."
tar -xzf "$ARCHIVE_NAME" || {
    echo "Ошибка распаковки архива."
    exit 1
}

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
