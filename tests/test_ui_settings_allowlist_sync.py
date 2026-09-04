"""Сторож против рассинхрона двух проверок настроек интерфейса.

`_sanitize_full` проверяет весь файл настроек, `_sanitize_patch` — частичное
обновление из панели. Списки разрешённых ключей у них независимые, и новая
настройка легко попадает только в первый: на диске она тогда живёт, а PATCH
из браузера отвечает `400 bad patch`. Ровно так пропала раскладка окна
DNS-over-VLESS, поэтому расхождение ловим тестом, а не на роутере.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "xkeen-ui"))

SOURCE = (ROOT / "xkeen-ui" / "services" / "ui_settings.py").read_text(encoding="utf-8")


def _allowlist(func_name: str, next_name: str) -> set[str]:
    """Ключи из всех `if k not in (...)` внутри одной функции."""
    body = SOURCE[SOURCE.index(f"def {func_name}"):SOURCE.index(f"def {next_name}")]
    keys: set[str] = set()
    for block in re.finditer(r"if k not in \(([^)]*)\)", body, re.S):
        keys.update(re.findall(r'"([^"]+)"', block.group(1)))
    return keys


def test_allowlists_are_parsed_at_all():
    # Если разметку кода переписали, тест обязан упасть заметно, а не молча
    # сравнить два пустых множества.
    assert len(_allowlist("_sanitize_full", "_sanitize_patch")) > 10
    assert len(_allowlist("_sanitize_patch", "load_settings")) > 10


def test_full_and_patch_accept_the_same_keys():
    full = _allowlist("_sanitize_full", "_sanitize_patch")
    patch = _allowlist("_sanitize_patch", "load_settings")
    assert full - patch == set(), "настройка сохраняется, но не принимается по PATCH"
    assert patch - full == set(), "настройка принимается по PATCH, но теряется при чтении"
