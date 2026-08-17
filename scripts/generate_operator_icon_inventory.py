from __future__ import annotations

import argparse
import json
import re
import runpy
from collections import defaultdict
from html import unescape
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPRITE_GENERATOR = ROOT / "scripts" / "generate_operator_icon_sprite.py"
DEFAULT_OUTPUT = ROOT / "docs" / "panel-operator-icon-inventory.json"
TEMPLATE_SOURCES = (
    ROOT / "xkeen-ui" / "templates" / "panel.html",
    ROOT / "xkeen-ui" / "templates" / "mihomo_generator.html",
)
JS_ROOT = ROOT / "xkeen-ui" / "static" / "js"

# Fallback labels document the runtime intent for factory-created buttons. Static
# template controls keep their exact aria-label/title/visible label instead.
ACCESSIBLE_LABELS = {
    "add-balancer": "Добавить балансировщик", "add-node": "Добавить", "add-rule": "Д��бавить правило",
    "alert": "Предупреждение", "apply": "Применить", "archive": "Создать архив",
    "back": "Назад", "bolt": "Быстрое действие", "bookmark": "Закладка", "broom": "Очистить журнал",
    "catalog": "Открыть каталог", "check": "Подтвердить", "chevron-down": "Раскрыть",
    "clear": "Очистить", "close": "Закрыть", "comment": "Комментарии",
    "compare": "Сравнить", "dashboard": "Открыть панель", "detach": "Отсоединиться",
    "devices": "Устройства", "dns": "Показать доменные имена", "download": "Скачать", "drag": "Перетащить",
    "duplicate": "Копировать", "edit": "Редактировать", "export": "Экспорт",
    "file-add": "Создать файл", "folder-add": "Создать папку", "format": "Форматировать",
    "forward": "Вперёд", "fullscreen": "Полный экран", "fullscreen-exit": "Восстановить",
    "github": "GitHub", "help": "Справка", "home": "Домой", "hwid": "HWID",
    "import": "Импортировать", "info": "Информация", "list-details": "Список",
    "loading": "Загрузка", "lock": "Ограничить", "minimize": "Свернуть",
    "moon": "Тёмная тема", "more": "Дополнительные действия", "move-down": "Вниз",
    "move-up": "Вверх", "normalize": "Нормализовать", "open": "Открыть",
    "owner": "Владелец", "pause": "Пауза", "permissions": "Права доступа",
    "ping": "Проверить задержку", "play": "Запустить", "pool": "Пул", "preview": "Предпросмотр",
    "quick-fix": "Быстрое исправление", "quick-start": "Быстрый старт", "refresh": "Обновить",
    "reload": "Перезагрузить", "replace": "Заменить", "restart": "Перезапустить",
    "restore": "Восстановить", "save": "Сохранить", "search": "Поиск", "settings": "Настройки",
    "stop": "Остановить", "storage": "Хранилище", "subscriptions": "Подписки",
    "sun": "Светлая тема", "template": "Шаблоны", "terminal": "Терминал",
    "tools": "Инструменты", "transfer": "Перенести", "trash": "Удалить",
    "upload": "Загрузить", "validate": "Проверить", "x": "Исключить",
}

CONTROL_RE = re.compile(
    r"<(?P<tag>button|summary|a)\b(?P<attrs>[^>]*)>(?P<body>.*?)</(?P=tag)>",
    re.IGNORECASE | re.DOTALL,
)
ICON_RE = re.compile(r"op_icon\(\s*['\"](?P<name>[a-z0-9-]+)['\"]")
ATTR_RE = re.compile(r"\b(?P<name>aria-label|title)\s*=\s*(['\"])(?P<value>.*?)\2", re.IGNORECASE | re.DOTALL)
DIRECT_CALLS = (
    re.compile(r"\b(?:iconHtml|iconHref|op_icon)\s*\(\s*['\"](?P<name>[a-z0-9-]+)['\"]"),
    re.compile(r"\bsetIcon\([^,]+,\s*['\"](?P<name>[a-z0-9-]+)['\"]"),
)
QUOTED_VALUE_TEMPLATE = r"(?<![\w-])['\"]{name}['\"](?![\w-])"


def normalize(value: str) -> str:
    return re.sub(r"\s+", " ", unescape(value or "")).strip()


def attrs_label(attrs: str, body: str, fallback: str) -> str:
    values = {match.group("name").lower(): normalize(match.group("value")) for match in ATTR_RE.finditer(attrs)}
    if values.get("aria-label"):
        return values["aria-label"]
    if values.get("title"):
        return values["title"]
    visible = normalize(re.sub(r"{{\s*op_icon\([^}]+}}|<[^>]+>", "", body))
    return visible or fallback


def control_type(tag: str, attrs: str, body: str) -> str:
    visible = normalize(re.sub(r"{{\s*op_icon\([^}]+}}|<[^>]+>", "", body))
    if tag.lower() == "a":
        return "navigation"
    if not visible:
        return "icon-only"
    return "text+icon"


def location(path: Path, source: str, offset: int) -> str:
    return f"{path.relative_to(ROOT).as_posix()}:L{source.count(chr(10), 0, offset) + 1}"


def add_usage(usages: dict[str, list[dict[str, str]]], name: str, item: dict[str, str]) -> None:
    if item not in usages[name]:
        usages[name].append(item)


def scan_templates(usages: dict[str, list[dict[str, str]]], names: set[str], unknown: set[str]) -> None:
    for path in TEMPLATE_SOURCES:
        source = path.read_text(encoding="utf-8")
        for control in CONTROL_RE.finditer(source):
            tag, attrs, body = control.group("tag"), control.group("attrs"), control.group("body")
            for icon in ICON_RE.finditer(body):
                name = icon.group("name")
                if name not in names:
                    unknown.add(name)
                    continue
                add_usage(usages, name, {
                    "location": location(path, source, control.start()),
                    "control_type": control_type(tag, attrs, body),
                    "accessible_label": attrs_label(attrs, body, ACCESSIBLE_LABELS.get(name, name)),
                })


def scan_js(usages: dict[str, list[dict[str, str]]], names: set[str], unknown: set[str]) -> None:
    for path in sorted(JS_ROOT.rglob("*.js")):
        if "vendor" in path.parts or "frontend-build" in path.parts:
            continue
        source = path.read_text(encoding="utf-8", errors="replace")
        helper_driven = "iconHtml(" in source or "setIcon(" in source or "operatorIcons" in source
        for pattern in DIRECT_CALLS:
            for match in pattern.finditer(source):
                name = match.group("name")
                if name not in names:
                    unknown.add(name)
                    continue
                add_usage(usages, name, {
                    "location": location(path, source, match.start()),
                    "control_type": "runtime-action",
                    "accessible_label": ACCESSIBLE_LABELS.get(name, name),
                })
        # Controlled factories hold semantic names in maps/conditionals. Their
        # values are protected by the browser helper's generated allowlist.
        if helper_driven:
            for name in names:
                match = re.search(QUOTED_VALUE_TEMPLATE.format(name=re.escape(name)), source)
                if match:
                    add_usage(usages, name, {
                        "location": location(path, source, match.start()),
                        "control_type": "runtime-action",
                        "accessible_label": ACCESSIBLE_LABELS.get(name, name),
                    })


def build_payload() -> dict[str, object]:
    icons = runpy.run_path(str(SPRITE_GENERATOR))["ICONS"]
    names = set(icons)
    usages: dict[str, list[dict[str, str]]] = defaultdict(list)
    unknown: set[str] = set()
    scan_templates(usages, names, unknown)
    scan_js(usages, names, unknown)
    unknown -= names
    items = []
    for name, asset in sorted(icons.items()):
        entries = sorted(usages[name], key=lambda item: (item["location"], item["control_type"], item["accessible_label"]))
        items.append({
            "semantic_name": name,
            "tabler_asset": asset,
            "usage": entries,
        })
    return {
        "schema_version": 1,
        "generated_from": "scripts/generate_operator_icon_inventory.py",
        "sprite": "xkeen-ui/static/icons/operator.svg",
        "license": "xkeen-ui/static/icons/tabler-icons.LICENSE",
        "item_count": len(items),
        "unknown_direct_semantic_names": sorted(unknown),
        "unused_semantic_names": [item["semantic_name"] for item in items if not item["usage"]],
        "items": items,
        "documented_exceptions": {
            "content_and_status": [
                "country flags in static/js/features/outbounds.js and static/js/features/mihomo_clash/visuals.js",
                "Monaco/Codemirror vendor internals",
                "textual keyboard shortcuts and non-interactive status text",
            ],
            "not_action_or_navigation_glyphs": [
                "service logos, flags and content images",
                "semantic state marks that are not interactive controls",
            ],
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate the Operator icon usage inventory.")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--stdout", action="store_true")
    args = parser.parse_args()
    payload = build_payload()
    rendered = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    if args.stdout:
        print(rendered, end="")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
