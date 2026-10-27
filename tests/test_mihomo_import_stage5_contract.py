"""Stage 5 destination/group/refresh contracts; Playwright covers UI flows."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / "xkeen-ui/static/js/features/mihomo_import.js").read_text(encoding="utf-8")
TEMPLATE = (ROOT / "xkeen-ui/templates/panel/modals/mihomo.html").read_text(encoding="utf-8")
ROUTE = (ROOT / "xkeen-ui/routes/mihomo.py").read_text(encoding="utf-8")
SERVICE = (ROOT / "xkeen-ui/services/mihomo_proxy_config.py").read_text(encoding="utf-8")
PLAN = (ROOT / "README-mihomo-node-import-redesign-plan.md").read_text(encoding="utf-8")
DOC = (ROOT / "docs/mihomo-node-import-stage5.md").read_text(encoding="utf-8")


def test_stage5_has_explicit_destination_and_group_ui():
    for fragment in (
        'id="mihomo-import-destination-block"',
        'value="static"',
        'value="provider"',
        'id="mihomo-import-provider-name"',
        'id="mihomo-import-provider-interval"',
        'id="mihomo-import-groups-count"',
    ):
        assert fragment in TEMPLATE
    for fragment in (
        "destinationVariantsForOutputs",
        "setImportDestination",
        "providerOutputsForInsert",
        "attachProvidersToGroups",
        "selectedDestination",
        "missingGroups",
    ):
        assert fragment in JS


def test_stage5_uses_provider_use_and_reports_unknown_groups():
    assert 'def insert_provider_into_groups' in SERVICE
    assert 'field_name: str' in SERVICE
    assert '@bp.post("/api/mihomo/patch/attach_providers")' in ROUTE
    assert 'missing_groups' in ROUTE
    assert 'insert_provider_into_groups' in ROUTE
    assert "intervalSeconds = selectedProviderIntervalHours() * 3600" in JS


def test_stage5_is_documented_and_plan_is_closed():
    assert "### Этап 5. Назначение, группы и автообновление — закрыт" in PLAN
    assert "Этап 5" in DOC
    assert "Следующий шаг" in DOC
