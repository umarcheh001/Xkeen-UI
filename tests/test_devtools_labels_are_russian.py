"""Подписи DevTools должны читаться по-русски.

Сторож против отката перевода: кнопки, колонки и подписи полей на вкладках
«Инструменты» и «Логи» пишутся по-русски. Технические значения (уровни логов,
имена шрифтов и логов, ключи ENV) намеренно остаются латиницей — они не подписи,
а данные, и их список зафиксирован ниже.
"""

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "xkeen-ui/templates/devtools.html"

# Осознанные исключения: значения переменных, имена файлов и шрифтов, схема ссылки.
ALLOWED_LATIN = {
    "Xkeen UI — DevTools",
    "DevTools",
    "ENV (разрешённые переменные)",
    "happ://crypt…",
    "ERROR",
    "WARNING",
    "INFO",
    "DEBUG",
    "Favicon",
    "System UI",
    "Arial",
    "Tahoma",
    "Verdana",
    "System monospace",
    "Consolas",
    "Courier New",
}


def _visible_texts(html: str):
    for match in re.finditer(r">([^<>{}]{2,60})<", html):
        text = " ".join(match.group(1).split())
        if text:
            yield text


def test_no_english_only_labels_left_in_the_template():
    html = TEMPLATE.read_text(encoding="utf-8")

    leftovers = sorted(
        {
            text
            for text in _visible_texts(html)
            if re.search(r"[A-Za-z]", text)
            and not re.search(r"[А-Яа-я]", text)
            and text not in ALLOWED_LATIN
        }
    )

    assert leftovers == [], leftovers


def test_key_buttons_carry_their_russian_labels():
    html = TEMPLATE.read_text(encoding="utf-8")

    expected = {
        "dt-ui-start": "Запустить",
        "dt-ui-stop": "Остановить",
        "dt-ui-restart": "Перезапустить",
        "dt-update-run": "Обновить панель",
        "dt-update-rollback": "Откатить",
        "dt-update-open-logs": "Открыть логи",
        "dt-branding-save": "Сохранить",
        "dt-branding-reset": "Сбросить",
        "dt-layout-tabs-reset": "Сбросить вкладки",
        "dt-log-load-more": "Загрузить ещё",
        "dt-tab-btn-tools": "Инструменты",
        "dt-tab-btn-logs": "Логи",
    }

    for el_id, label in expected.items():
        pattern = re.compile(r'id="' + re.escape(el_id) + r'"[^>]*>([^<]*)<')
        found = pattern.search(html)
        assert found, el_id
        assert found.group(1).strip() == label, (el_id, found.group(1).strip())


def test_panel_restart_is_named_in_russian():
    html = TEMPLATE.read_text(encoding="utf-8")
    env_js = (ROOT / "xkeen-ui/static/js/features/devtools/env.js").read_text(encoding="utf-8")

    # «Restart UI» — жаргон установщика, в интерфейсе говорим «перезапуск панели».
    assert "Restart UI" not in html
    assert "Restart UI" not in env_js.replace("// Для них изменения надёжнее применять через Restart UI", "")


def test_update_card_messages_are_russian():
    update_js = (ROOT / "xkeen-ui/static/js/features/devtools/update.js").read_text(encoding="utf-8")

    for phrase in (
        "'Запускаем обновление…'",
        "'Запускаем откат…'",
        "'Откатить'",
        "'Не удалось получить статус: '",
    ):
        assert phrase in update_js, phrase

    for stale in ("'Starting update", "'Rollback failed", "'Status error", "'Run failed"):
        assert stale not in update_js, stale
