"""DevTools card «Декриптор Happ» and the links to it from subscription errors."""

from __future__ import annotations

import re
from pathlib import Path

from services import happ_links

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "xkeen-ui"
TEMPLATE = APP / "templates" / "devtools.html"
CARD_JS = APP / "static" / "js" / "features" / "devtools" / "happ_decryptor.js"
LINK_JS = APP / "static" / "js" / "ui" / "happ_decryptor_link.js"
BOOTSTRAP = APP / "static" / "js" / "pages" / "devtools.screen.bootstrap.js"
DEVTOOLS_JS = APP / "static" / "js" / "features" / "devtools.js"

CARD_CONTROL_IDS = (
    "dt-happ-decryptor-card",
    "dt-happ-verdict",
    "dt-happ-engine",
    "dt-happ-formats",
    "dt-happ-keys",
    "dt-happ-keyset",
    "dt-happ-install",
    "dt-happ-update-keys",
    "dt-happ-upload",
    "dt-happ-upload-input",
    "dt-happ-refresh",
    "dt-happ-status",
    "dt-happ-check-link",
    "dt-happ-check-run",
    "dt-happ-check-result",
)


def _card_markup() -> str:
    text = TEMPLATE.read_text(encoding="utf-8")
    start = text.index('id="dt-happ-decryptor-card"')
    end = text.index("</details>\n\n", text.index('id="dt-happ-check-result"'))
    return text[start:end]


def test_card_sits_in_the_tools_tab_after_panel_update():
    text = TEMPLATE.read_text(encoding="utf-8")
    update = text.index('id="dt-update-card"')
    card = text.index('id="dt-happ-decryptor-card"')
    logging = text.index('id="dt-logging-card"')
    assert update < card < logging
    for control_id in CARD_CONTROL_IDS:
        assert f'id="{control_id}"' in text, control_id


def test_card_speaks_russian():
    markup = _card_markup()
    assert ">Обновить<" in markup
    assert "Refresh" not in markup


def test_card_script_is_loaded_and_initialised_with_the_card():
    assert "features/devtools/happ_decryptor.js" in BOOTSTRAP.read_text(encoding="utf-8")
    devtools = DEVTOOLS_JS.read_text(encoding="utf-8")
    assert re.search(r"'devtoolsHappDecryptor',\s*'dt-happ-decryptor-card'", devtools)
    card = CARD_JS.read_text(encoding="utf-8")
    assert "setDevtoolsNamespaceApi('devtoolsHappDecryptor'" in card
    for route in ("/api/happ-decryptor/status", "/api/happ-decryptor/install", "/api/happ-decryptor/keys",
                  "/api/happ-decryptor/keys/upload", "/api/happ-decryptor/check"):
        assert route in card


def test_backend_messages_and_frontend_link_share_the_card_label():
    link = LINK_JS.read_text(encoding="utf-8")
    assert f"'{happ_links.HAPP_DECRYPTOR_CARD_LABEL}'" in link
    assert "#dt-happ-decryptor-card" in link


def test_subscription_windows_link_errors_to_the_card():
    for name in ("outbounds.js", "mihomo_import.js"):
        source = (APP / "static" / "js" / "features" / name).read_text(encoding="utf-8")
        assert "appendHappDecryptorCardLink" in source, name
        assert "../ui/happ_decryptor_link.js" in source, name
