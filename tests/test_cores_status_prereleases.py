from __future__ import annotations

import importlib.util
import sys
import threading
import time
import urllib.error
from pathlib import Path

from flask import Flask


ROOT = Path(__file__).resolve().parents[1]
CORES_STATUS_PATH = ROOT / "xkeen-ui" / "routes" / "cores_status.py"


def _load_cores_status_module():
    module_name = "test_cores_status_module"
    prev_module = sys.modules.get(module_name)
    prev_path = list(sys.path)
    try:
        sys.path.insert(0, str(ROOT / "xkeen-ui"))
        spec = importlib.util.spec_from_file_location(module_name, CORES_STATUS_PATH)
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        assert spec and spec.loader
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path[:] = prev_path
        if prev_module is not None:
            sys.modules[module_name] = prev_module
        else:
            sys.modules.pop(module_name, None)


cores_status = _load_cores_status_module()


def _make_cores_status_client(tmp_path: Path):
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(cores_status.create_cores_status_blueprint(str(tmp_path)))
    return app.test_client()


def _mock_installed_cores(monkeypatch):
    original_exists = cores_status.os.path.exists

    def fake_exists(path):
        if path in ("/opt/sbin/xray", "/opt/sbin/mihomo"):
            return True
        return original_exists(path)

    def fake_run_cmd(cmd, *, timeout_s=2.5):
        binary = str((cmd or [""])[0] or "")
        if binary == "/opt/sbin/xray":
            return 0, "Xray 26.1.1 (Xray, Penetrates Everything.)\n"
        if binary == "/opt/sbin/mihomo":
            return 0, "Mihomo Meta v1.18.2 linux arm64\n"
        return 127, ""

    monkeypatch.setattr(cores_status.os.path, "exists", fake_exists)
    monkeypatch.setattr(cores_status, "_run_cmd", fake_run_cmd)


def _wait_for_background_refresh(client, *, timeout_s: float = 2.5):
    deadline = time.time() + timeout_s
    last_payload = None
    while time.time() < deadline:
        last_payload = client.get("/api/cores/updates").get_json()
        if last_payload and not last_payload.get("refreshing"):
            return last_payload
        time.sleep(0.05)
    return last_payload


def test_cmp_versions_handles_prerelease_ordering():
    assert cores_status._cmp_versions("1.0.0", "1.0.0-rc1") > 0
    assert cores_status._cmp_versions("1.0.0-rc2", "1.0.0-rc1") > 0
    assert cores_status._cmp_versions("1.2.0", "1.10.0") < 0


def test_is_update_available_uses_version_order_not_raw_inequality():
    assert cores_status._is_update_available("25.10.15", "26.3.27") is True
    assert cores_status._is_update_available("26.4.25", "26.3.27") is False
    assert cores_status._is_update_available("1.0.0-rc1", "1.0.0") is True


def test_parse_mihomo_version_supports_alpha_build_output():
    output = "Mihomo Meta alpha-df1c5e5 linux arm64 with go1.26.2 Tue Apr 28 02:05:15 UTC 2026"
    assert cores_status._parse_mihomo_version(output) == "alpha-df1c5e5"


def test_pick_release_selects_latest_release_within_each_channel():
    releases = [
        {"tag_name": "alpha-1", "prerelease": True, "draft": False, "published_at": "2024-08-12T10:00:00Z"},
        {"tag_name": "v1.2.0", "prerelease": False, "draft": False, "published_at": "2026-04-20T10:00:00Z"},
        {"tag_name": "v1.1.9", "prerelease": False, "draft": False, "published_at": "2026-04-12T10:00:00Z"},
        {"tag_name": "alpha-2", "prerelease": True, "draft": False, "published_at": "2025-02-01T10:00:00Z"},
    ]

    stable = cores_status._pick_release(releases, prerelease=False)
    prerelease = cores_status._pick_release(releases, prerelease=True)

    assert stable["tag_name"] == "v1.2.0"
    assert prerelease["tag_name"] == "alpha-2"


def test_github_latest_release_network_failure_does_not_log_exception(monkeypatch):
    def fail_urlopen(_req, timeout):
        raise urllib.error.URLError("Temporary failure in name resolution")

    logged = []
    monkeypatch.setattr(cores_status.urllib.request, "urlopen", fail_urlopen)
    monkeypatch.setattr(
        cores_status,
        "log_route_exception",
        lambda *args, **kwargs: logged.append((args, kwargs)),
    )

    data = cores_status._github_latest_release_tag("XTLS/Xray-core", timeout_s=0.1)

    assert data["ok"] is False
    assert data["error"] == "request_failed"
    assert logged == []


def test_github_latest_release_unexpected_failure_still_logs_exception(monkeypatch):
    def fail_urlopen(_req, timeout):
        raise ValueError("bad payload")

    logged = []
    monkeypatch.setattr(cores_status.urllib.request, "urlopen", fail_urlopen)
    monkeypatch.setattr(
        cores_status,
        "log_route_exception",
        lambda *args, **kwargs: logged.append((args, kwargs)),
    )

    data = cores_status._github_latest_release_tag("XTLS/Xray-core", timeout_s=0.1)

    assert data["ok"] is False
    assert data["error"] == "request_failed"
    assert logged == [(("cores_status.request_failed",), {"repo": "XTLS/Xray-core"})]


def test_resolve_mihomo_prerelease_install_selects_arch_specific_gz_asset():
    raw_release = {
        "assets": [
            {"name": "checksums.txt", "browser_download_url": "https://example.test/checksums.txt"},
            {"name": "mihomo-linux-arm64-alpha-abc123.gz", "browser_download_url": "https://example.test/arm64.gz"},
            {"name": "mihomo-linux-arm64-alpha-abc123.deb", "browser_download_url": "https://example.test/arm64.deb"},
            {"name": "mihomo-linux-amd64-alpha-abc123.gz", "browser_download_url": "https://example.test/amd64.gz"},
        ]
    }

    plan = cores_status._resolve_mihomo_prerelease_install(
        raw_release,
        arch="aarch64",
        opkg_arch="aarch64_generic",
        endian="le",
    )

    assert plan["mode"] == "direct_asset"
    assert plan["supported"] is True
    assert plan["checksum_url"] == "https://example.test/checksums.txt"
    assert [asset["name"] for asset in plan["assets"]] == ["mihomo-linux-arm64-alpha-abc123.gz"]
    assert plan["build_id"] == "alpha-abc123"
    assert plan["build_ids"] == ["alpha-abc123"]


def test_resolve_mihomo_prerelease_install_prefers_softfloat_first_on_mips():
    raw_release = {
        "assets": [
            {"name": "mihomo-linux-mipsle-hardfloat-alpha-abc123.gz", "browser_download_url": "https://example.test/mipsle-hardfloat.gz"},
            {"name": "mihomo-linux-mipsle-softfloat-alpha-abc123.gz", "browser_download_url": "https://example.test/mipsle-softfloat.gz"},
        ]
    }

    plan = cores_status._resolve_mihomo_prerelease_install(
        raw_release,
        arch="mipsel",
        opkg_arch="mipsel_24kc",
        endian="le",
    )

    assert plan["supported"] is True
    assert [asset["name"] for asset in plan["assets"]] == [
        "mihomo-linux-mipsle-softfloat-alpha-abc123.gz",
        "mihomo-linux-mipsle-hardfloat-alpha-abc123.gz",
    ]
    assert plan["build_id"] == "alpha-abc123"
    assert plan["build_ids"] == ["alpha-abc123"]
    assert "softfloat" in plan["note"]


def test_cores_updates_returns_immediately_and_refreshes_in_background(tmp_path, monkeypatch):
    client = _make_cores_status_client(tmp_path)
    _mock_installed_cores(monkeypatch)

    gate = threading.Event()

    def fake_latest_release_or_skip(repo, *, installed, timeout_s):
        assert installed is True
        gate.wait(2.0)
        if repo == "XTLS/Xray-core":
            return {
                "ok": True,
                "repo": repo,
                "tag": "v26.3.27",
                "url": "https://example.test/xray",
                "stable": {"tag": "v26.3.27", "url": "https://example.test/xray"},
                "prerelease": None,
                "error": None,
                "meta": None,
                "skipped": False,
            }
        return {
            "ok": True,
            "repo": repo,
            "tag": "v1.19.27",
            "url": "https://example.test/mihomo",
            "stable": {"tag": "v1.19.27", "url": "https://example.test/mihomo"},
            "prerelease": None,
            "error": None,
            "meta": None,
            "skipped": False,
        }

    monkeypatch.setattr(cores_status, "_latest_release_or_skip", fake_latest_release_or_skip)

    started_at = time.perf_counter()
    response = client.get("/api/cores/updates")
    elapsed_s = time.perf_counter() - started_at
    payload = response.get_json()

    assert response.status_code == 200
    assert elapsed_s < 0.25
    assert payload["refreshing"] is True
    assert payload["latest"] == {"xray": {}, "mihomo": {}}
    assert payload["installed"]["xray"]["version"] == "26.1.1"
    assert payload["installed"]["mihomo"]["version"] == "1.18.2"
    assert payload["update_available"]["xray"] is False
    assert payload["update_available"]["mihomo"] is False

    gate.set()
    settled = _wait_for_background_refresh(client)

    assert settled is not None
    assert settled["refreshing"] is False
    assert settled["latest"]["xray"]["stable"]["tag"] == "v26.3.27"
    assert settled["latest"]["mihomo"]["stable"]["tag"] == "v1.19.27"
    assert settled["update_available"]["xray"] is True
    assert settled["update_available"]["mihomo"] is True


def test_cores_updates_returns_stale_cache_while_refresh_runs_in_background(tmp_path, monkeypatch):
    client = _make_cores_status_client(tmp_path)
    _mock_installed_cores(monkeypatch)

    cache_path = tmp_path / "cores_updates_cache.json"
    cores_status._write_json_atomic(
        str(cache_path),
        {
            "format_version": cores_status._CACHE_FORMAT_VERSION,
            "checked_ts": time.time() - 7200,
            "ttl_s": 60,
            "stale": False,
            "data": {
                "ok": True,
                "latest": {
                    "xray": {
                        "ok": True,
                        "tag": "v26.2.0",
                        "url": "https://example.test/xray-old",
                        "stable": {"tag": "v26.2.0", "url": "https://example.test/xray-old"},
                        "prerelease": None,
                    },
                    "mihomo": {
                        "ok": True,
                        "tag": "v1.19.20",
                        "url": "https://example.test/mihomo-old",
                        "stable": {"tag": "v1.19.20", "url": "https://example.test/mihomo-old"},
                        "prerelease": None,
                    },
                },
            },
        },
    )

    gate = threading.Event()

    def fake_latest_release_or_skip(repo, *, installed, timeout_s):
        assert installed is True
        gate.wait(2.0)
        return {
            "ok": True,
            "repo": repo,
            "tag": "v99.0.0",
            "url": "https://example.test/new",
            "stable": {"tag": "v99.0.0", "url": "https://example.test/new"},
            "prerelease": None,
            "error": None,
            "meta": None,
            "skipped": False,
        }

    monkeypatch.setattr(cores_status, "_latest_release_or_skip", fake_latest_release_or_skip)

    started_at = time.perf_counter()
    response = client.get("/api/cores/updates")
    elapsed_s = time.perf_counter() - started_at
    payload = response.get_json()

    assert response.status_code == 200
    assert elapsed_s < 0.25
    assert payload["refreshing"] is True
    assert payload["stale"] is True
    assert payload["latest"]["xray"]["stable"]["tag"] == "v26.2.0"
    assert payload["latest"]["mihomo"]["stable"]["tag"] == "v1.19.20"
    assert payload["update_available"]["xray"] is True
    assert payload["update_available"]["mihomo"] is True

    gate.set()
    settled = _wait_for_background_refresh(client)
    assert settled is not None
    assert settled["refreshing"] is False


def test_commands_panel_has_dedicated_prerelease_links_and_styles():
    template = (ROOT / "xkeen-ui" / "templates" / "panel.html").read_text(encoding="utf-8")
    styles = (ROOT / "xkeen-ui" / "static" / "styles.css").read_text(encoding="utf-8")
    script = (ROOT / "xkeen-ui" / "static" / "js" / "features" / "cores_status.js").read_text(encoding="utf-8")

    assert 'id="core-xray-prerelease"' in template
    assert 'id="core-mihomo-prerelease"' in template
    assert 'id="core-xray-prerelease-update-btn"' in template
    assert 'id="core-mihomo-prerelease-update-btn"' in template
    assert '.commands-status-row .core-prerelease {' in styles
    assert '.commands-status-row .btn-prerelease-action {' in styles
    assert 'function buildPrereleaseUpdateCommand(flag, tag, coreLabel)' in script
    assert 'function buildPrereleaseVersionSummaryCommand(flag, coreLabel)' in script
    assert 'function buildMihomoPrereleaseInstallCommand(tag, installMeta, coreLabel)' in script
    assert 'function buildQuietTerminalScript(lines)' in script
    assert 'function buildShellScript(lines)' in script
    assert 'function formatInstalledVersionLabel(version)' in script
    assert "Запускаем обновление ${normalizedCore} до pre-release ${releaseLabel}." in script
    assert "Xkeen ниже выполнит установку и покажет свой прогресс." in script
    assert "Обновление ${normalizedCore} завершено." in script
    assert "printf '%s\\\\n%s\\\\n' '9'" in script
    assert '/opt/sbin/xray version 2>/dev/null | head -n 1' in script
    assert 'Текущая версия ${normalizedCore}: $__xk_installed_version' in script
    assert 'stty -echo 2>/dev/null || true' in script
    assert 'return buildQuietTerminalScript(lines.filter(Boolean));' in script
    assert "btn.dataset.prereleaseMode = 'direct_asset';" in script
    assert "command = buildMihomoPrereleaseInstallCommand(tag, installMeta, coreLabel);" in script
    assert 'const installedIsCurrentDirect = !!installedToken && buildIds.includes(installedToken);' in script
    assert "const displayTag = String((release && (release.display_tag || release.tag)) || '').trim();" in script
    assert ".join('\\n');" in script
    assert ".join('; ');" not in script
    assert "return parts.filter(Boolean).join(' ');" not in script
    assert 'btn.dataset.tooltip = btn.title;' in script
    assert "const xPre = x.prerelease || null;" in script
    assert "const mPre = m.prerelease || null;" in script
