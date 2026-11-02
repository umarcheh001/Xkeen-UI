"""DevTools shows the panel tabs of the installed profile and fills its rows.

Minimal profiles reach DevTools without the diagnostics module and without the
link utility, so the page must not offer renaming or ordering of tabs the panel
does not have, and the logging card must not stand at half width alone.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from tests.support.panel_render import (
    FULL_MODULE_IDS,
    MIHOMO_MINIMAL_MODULE_IDS,
    ROOT,
    XRAY_MINIMAL_MODULE_IDS,
    build_panel_app,
)


ALL_TAB_KEYS = (
    "view:routing",
    "view:mihomo",
    "view:xkeen",
    "view:xray-logs",
    "view:commands",
    "view:files",
    "id:top-tab-mihomo-generator",
    "id:top-tab-donate",
)


def devtools_html(module_ids, tmp_path: Path) -> str:
    response = build_panel_app(module_ids, tmp_path).test_client().get("/devtools")
    assert response.status_code == 200
    return response.get_data(as_text=True)


def rename_keys(html: str) -> list[str]:
    block = re.search(r'id="dt-branding-tab-rename".*?</div>\s*</div>', html, re.S).group(0)
    return re.findall(r'data-tab-key="([^"]+)"', block)


def hidden_sections(html: str) -> set[str]:
    match = re.search(r'id="dt-layout-tab-list"[^>]*data-hidden-sections="([^"]*)"', html)
    assert match, "the tab order list must say which sections the profile lacks"
    return {item for item in match.group(1).split(",") if item}


def logging_card_classes(html: str) -> set[str]:
    tag = re.search(r'<details[^>]*id="dt-logging-card"[^>]*>', html).group(0)
    return set(re.search(r'class="([^"]*)"', tag).group(1).split())


def test_xray_minimal_renames_only_its_own_tabs(tmp_path):
    html = devtools_html(XRAY_MINIMAL_MODULE_IDS, tmp_path)

    assert rename_keys(html) == ["view:routing", "view:xkeen", "view:xray-logs", "id:top-tab-donate"]
    assert hidden_sections(html) == {"mihomo", "mihomo-generator", "commands", "files"}


def test_mihomo_minimal_renames_only_its_own_tabs(tmp_path):
    html = devtools_html(MIHOMO_MINIMAL_MODULE_IDS, tmp_path)

    assert rename_keys(html) == ["view:mihomo", "view:xkeen", "id:top-tab-mihomo-generator", "id:top-tab-donate"]
    assert hidden_sections(html) == {"routing", "xray-logs", "commands", "files"}


@pytest.mark.parametrize("module_ids", [FULL_MODULE_IDS, None], ids=["full", "no-module-gating"])
def test_full_panel_keeps_every_tab(tmp_path, module_ids):
    html = devtools_html(module_ids, tmp_path)

    assert rename_keys(html) == list(ALL_TAB_KEYS)
    assert hidden_sections(html) == set()


def test_logging_card_spans_the_row_without_link_utility(tmp_path):
    html = devtools_html(XRAY_MINIMAL_MODULE_IDS, tmp_path)

    assert 'id="dt-happ-decryptor-card"' not in html
    assert "dt-card-wide" in logging_card_classes(html)


def test_logging_card_shares_the_row_with_link_utility(tmp_path):
    html = devtools_html(FULL_MODULE_IDS, tmp_path)

    assert 'id="dt-happ-decryptor-card"' in html
    assert "dt-card-wide" not in logging_card_classes(html)


def test_logging_fields_are_grouped_into_two_columns(tmp_path):
    html = devtools_html(XRAY_MINIMAL_MODULE_IDS, tmp_path)
    grid = re.search(r'<div class="dt-logging-grid".*?<div class="dt-logging-actions">', html, re.S).group(0)
    columns = re.findall(r'<div class="dt-logging-col">(.*?)</div>\s*(?=<div class="dt-logging-col">|</div>)', grid, re.S)

    assert len(columns) == 2
    assert all(token in columns[0] for token in ("dt-log-core-level", "dt-log-core-enable", "dt-log-ws-enable"))
    assert all(token in columns[1] for token in ("dt-log-rotate-mb", "dt-log-rotate-backups"))


def test_resource_offer_says_what_the_module_gives(tmp_path):
    html = build_panel_app(XRAY_MINIMAL_MODULE_IDS, tmp_path).test_client().get("/").get_data(as_text=True)
    offer = re.search(r'<a[^>]*id="xk-resource-monitor-install-offer"[^>]*>', html, re.S).group(0)
    text = "Графики, история нагрузки и события роутера — в модуле «Расширенная диагностика». Нажмите, чтобы установить."

    assert f'data-tooltip="{text}"' in offer
    assert f'aria-label="{text}"' in offer
    assert "Для просмотра CPU и RAM" not in offer


def test_resource_offer_is_not_styled_as_a_link():
    css = (ROOT / "xkeen-ui" / "static" / "panel-operator.css").read_text(encoding="utf-8")
    rule = re.search(r"#xk-resource-monitor-install-offer[^{]*\{[^}]*\}", css)

    assert rule, "the install offer needs its own rule against link colour and underline"
    assert "text-decoration: none" in rule.group(0)
    assert "color: var(--op-muted)" in rule.group(0)
