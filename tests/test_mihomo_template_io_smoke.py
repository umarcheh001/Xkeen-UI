from __future__ import annotations

import sys
from pathlib import Path

from flask import Flask


ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "xkeen-ui"

if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))


from routes.mihomo import create_mihomo_blueprint


def test_get_mihomo_template_reads_utf8_unicode_content(tmp_path: Path):
    templates_dir = tmp_path / "templates"
    templates_dir.mkdir()
    template_path = templates_dir / "zkeen.yaml"
    content = 'proxy-groups:\n  - name: "Заблок. сервисы ⚡️"\n'
    template_path.write_text(content, encoding="utf-8")

    app = Flask("mihomo-template-io-smoke")
    app.register_blueprint(
        create_mihomo_blueprint(
            MIHOMO_CONFIG_FILE=str(tmp_path / "config.yaml"),
            MIHOMO_TEMPLATES_DIR=str(templates_dir),
            MIHOMO_DEFAULT_TEMPLATE=str(template_path),
            restart_xkeen=lambda **_: False,
        )
    )

    client = app.test_client()
    response = client.get("/api/mihomo-template?name=zkeen.yaml")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["name"] == "zkeen.yaml"
    assert payload["content"] == content
