#!/bin/sh
# После git pull проверяет, не сменились ли у автора файлы данных утилиты ссылок
# (scripts/check_keys_upstream.py). Ничего не коммитит и никогда не мешает pull.
#
# Включить один раз:  git config core.hooksPath .githooks
# Пропустить разово:  XKEEN_SKIP_KEYS_CHECK=1 git pull

[ "${XKEEN_SKIP_KEYS_CHECK:-}" = "1" ] && exit 0

# $0 — путь к post-merge/post-rewrite: git передаёт его с «/», в тестах на Windows бывает «\».
case $0 in
  */*) hooks_dir=${0%/*} ;;
  *\\*) hooks_dir=${0%\\*} ;;
  *) hooks_dir=. ;;
esac
script="$hooks_dir/../scripts/check_keys_upstream.py"
[ -f "$script" ] || exit 0

py=""
for candidate in python3 python; do
  # --version отсеивает заглушку Microsoft Store, которая есть в PATH, но не запускается.
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" --version >/dev/null 2>&1; then
    py=$candidate
    break
  fi
done
if [ -z "$py" ]; then
  echo "[проверка ключей] пропущено: не найден Python"
  exit 0
fi

PYTHONIOENCODING=utf-8 "$py" "$script" 2>&1 | while IFS= read -r line; do
  echo "[проверка ключей] $line"
done
exit 0
