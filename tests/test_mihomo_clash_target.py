from __future__ import annotations

from pathlib import Path

import pytest

from services import mihomo_clash_target as target_module
from services.mihomo_clash_target import (
    discover_mihomo_clash_target,
    parse_allowed_clash_api_ports,
    parse_mihomo_clash_config,
)


def write_config(root: Path, content: str) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    path = root / "config.yaml"
    path.write_text(content, encoding="utf-8")
    return path


def diagnostic_codes(result) -> set[str]:
    return {item.code for item in result.diagnostics}


def test_allowed_ports_default_and_explicit_values():
    assert parse_allowed_clash_api_ports({}) == frozenset({9090})
    assert parse_allowed_clash_api_ports({"XKEEN_CLASH_API_ALLOWED_PORTS": "9090, 9191"}) == frozenset(
        {9090, 9191}
    )


@pytest.mark.parametrize("raw", ["9090,bad", "0", "65536", "9090,", "９０９０"])
def test_malformed_explicit_allowed_ports_fail_closed(raw: str):
    assert parse_allowed_clash_api_ports({"XKEEN_CLASH_API_ALLOWED_PORTS": raw}) == frozenset()


def test_fallback_parser_supports_quotes_comments_and_ipv6(monkeypatch):
    monkeypatch.setattr(target_module, "_yaml", None)
    parsed = parse_mihomo_clash_config(
        "external-controller: '[::1]:9090' # local controller\n"
        'external-controller-unix: "run/mihomo.sock"\n'
        'secret: "value#inside" # removed comment\n'
        "nested:\n  secret: ignored\n"
    )

    assert parsed == {
        "external-controller": "[::1]:9090",
        "external-controller-unix": "run/mihomo.sock",
        "secret": "value#inside",
    }


def test_duplicate_sensitive_top_level_keys_are_rejected():
    with pytest.raises(ValueError, match="duplicate"):
        parse_mihomo_clash_config(
            "external-controller: 127.0.0.1:9090\n"
            "external-controller: 127.0.0.1:9191\n"
        )


def test_ipv6_binding_connects_only_to_ipv6_loopback(tmp_path: Path):
    root = tmp_path / "mihomo"
    config = write_config(root, "external-controller: '[::]:9090'\nsecret: test-secret\n")

    result = discover_mihomo_clash_target(config, root)

    assert result.target is not None
    assert result.target.loopback_host == "::1"
    assert result.target.port == 9090
    assert "test-secret" not in repr(result)
    assert "test-secret" not in str(result.public_dict())


def test_unix_path_cannot_escape_mihomo_root(tmp_path: Path):
    root = tmp_path / "mihomo"
    config = write_config(root, "external-controller-unix: ../outside.sock\n")

    result = discover_mihomo_clash_target(config, root, socket_probe=lambda _path: True)

    assert result.target is None
    assert "unix_socket_outside_root" in diagnostic_codes(result)


def test_config_file_cannot_be_read_outside_mihomo_root(tmp_path: Path):
    root = tmp_path / "mihomo"
    root.mkdir()
    config = tmp_path / "outside.yaml"
    config.write_text("external-controller: 127.0.0.1:9090\n", encoding="utf-8")

    result = discover_mihomo_clash_target(config, root)

    assert result.target is None
    assert diagnostic_codes(result) == {"config_outside_root"}


def test_missing_unix_socket_falls_back_to_allowlisted_tcp(tmp_path: Path):
    root = tmp_path / "mihomo"
    config = write_config(
        root,
        "external-controller-unix: run/missing.sock\n"
        "external-controller: 0.0.0.0:9090\n"
        "secret: test-secret\n",
    )

    result = discover_mihomo_clash_target(config, root, socket_probe=lambda _path: False)

    assert result.target is not None
    assert result.target.transport == "tcp"
    assert result.target.loopback_host == "127.0.0.1"
    assert "unix_socket_missing" in diagnostic_codes(result)


def test_ambiguous_yaml_returns_safe_parse_diagnostic(tmp_path: Path):
    root = tmp_path / "mihomo"
    config = write_config(root, 'external-controller: "unterminated\nsecret: test-secret\n')

    result = discover_mihomo_clash_target(config, root)

    assert result.target is None
    assert diagnostic_codes(result) == {"config_parse_failed"}
    assert "test-secret" not in repr(result)
