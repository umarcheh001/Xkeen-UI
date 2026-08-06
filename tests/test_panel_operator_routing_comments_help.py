from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HELP = ROOT / "xkeen-ui" / "static" / "routing-comments-help.html"
ROUTING = ROOT / "xkeen-ui" / "static" / "js" / "features" / "routing.js"
OPERATOR_CSS = ROOT / "xkeen-ui" / "static" / "panel-operator.css"


def test_routing_comments_help_uses_operator_drawer_contract():
    routing = ROUTING.read_text(encoding="utf-8")
    css = OPERATOR_CSS.read_text(encoding="utf-8")

    assert "modal.dataset.operatorModalFamily = 'drawer-help';" in routing
    assert "modal.dataset.modalNopos = '1';" in routing
    assert "modal.dataset.modalNoresize = '1';" in routing
    assert "modal.dataset.modalRemember = '0';" in routing
    assert "content.className = 'modal-content xk-routing-help-shell';" in routing
    assert "body.className = 'modal-body xk-routing-help-body';" in routing
    assert "helpHost.className = 'xk-routing-help-host';" in routing
    assert "closeBtn.setAttribute('aria-label', 'Закрыть');" in routing
    assert "okBtn.textContent = 'Закрыть';" not in routing
    assert "content.appendChild(actions);" not in routing
    assert "#xkeen-routing-help-modal .xk-routing-help-shell" in css
    assert "#xkeen-routing-help-modal .xk-routing-help-host" in css
    assert "width: 100vw;" in css[css.index("body.panel-page #xkeen-routing-help-modal .xk-routing-help-shell", css.index("@media (max-width: 720px)")) :]

    legacy_inline_fragments = (
        "background:rgba(2,6,23,.65)",
        "background:rgba(15,23,42,.28)",
        "border-radius:999px",
        "rgba(96,165,250,.45)",
        "rgba(37,99,235,.18)",
    )
    help_modal_source = routing[
        routing.index("const HELP_MODAL_ID") : routing.index("function openHelp()")
    ]
    for fragment in legacy_inline_fragments:
        assert fragment not in help_modal_source


def test_routing_comments_help_describes_current_jsonc_storage_and_validation():
    help_text = HELP.read_text(encoding="utf-8")

    required_copy = (
        "отдельном JSONC sidecar-файле",
        "очищенный валидный <code>.json</code>",
        "Xray preflight",
        "JSONC active",
        "sidecar найден",
        "JSONC preserve",
        "routing.rules",
        "outboundTag",
        "balancerTag",
    )
    for copy in required_copy:
        assert copy in help_text

    assert "При сохранении комментарии удаляются" not in help_text
    assert "�" not in help_text
    assert "border-radius: 999px" not in help_text
    assert "#020617" not in help_text
    assert "#60a5fa" not in help_text
