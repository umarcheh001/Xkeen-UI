from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

import services.mihomo_rule_provider_inspector as inspector_service
from services.mihomo_rule_provider_inspector import (
    MAX_RULES,
    RuleProviderInspectorError,
    clear_rule_provider_inspector_cache,
    inspect_rule_provider,
)


def write_config(root: Path, providers: str) -> Path:
    config = root / "config.yaml"
    config.write_text(f"rule-providers:\n{providers}", encoding="utf-8")
    return config


def inspect(root: Path, config: Path, name: str, **options):
    return inspect_rule_provider(
        config_file=str(config), mihomo_root=str(root), provider_name=name, **options
    )


def test_inline_provider_is_bounded_searchable_and_has_no_path(tmp_path: Path):
    config = write_config(
        tmp_path,
        "  inline-one:\n    type: inline\n    behavior: domain\n    payload:\n"
        "      - example.test\n      - +.filtered.test\n      - final.test\n",
    )
    body = inspect(tmp_path, config, "inline-one", query="filter", limit=1)

    assert body["provider"] == {
        "name": "inline-one",
        "type": "inline",
        "behavior": "domain",
        "format": "inline",
    }
    assert body["rules"] == ["+.filtered.test"]
    assert body["matched_rules"] == 1
    assert body["cache"]["key"] == "inline"
    assert "path" not in json.dumps(body).lower()
    assert inspect(tmp_path, config, "inline-one")["cache"]["hit"] is True


def test_yaml_text_and_default_hashed_http_provider_are_supported(tmp_path: Path):
    rules = tmp_path / "rules"
    rules.mkdir()
    (rules / "one.yaml").write_text("payload:\n  - example.test\n  - +.two.test\n", encoding="utf-8")
    (rules / "two.txt").write_text("# ignore\n192.0.2.0/24\n// ignore\n198.51.100.0/24\n", encoding="utf-8")
    url = "https://example.invalid/default.txt"
    import hashlib

    (rules / hashlib.md5(url.encode()).hexdigest()).write_text("auto.test\n", encoding="utf-8")
    config = write_config(
        tmp_path,
        "  yaml-one: { type: file, behavior: domain, format: yaml, path: ./rules/one.yaml }\n"
        "  text-one: { type: file, behavior: ipcidr, format: text, path: ./rules/two.txt }\n"
        f"  http-default: {{ type: http, behavior: domain, format: text, url: {url} }}\n",
    )

    assert inspect(tmp_path, config, "yaml-one")["rules"] == ["example.test", "+.two.test"]
    assert inspect(tmp_path, config, "text-one")["rules"] == ["192.0.2.0/24", "198.51.100.0/24"]
    assert inspect(tmp_path, config, "http-default")["rules"] == ["auto.test"]


def test_symlink_traversal_directory_and_oversized_query_are_rejected(tmp_path: Path):
    outside = tmp_path.parent / "outside-provider.txt"
    outside.write_text("secret.test\n", encoding="utf-8")
    (tmp_path / "escape.txt").symlink_to(outside)
    config = write_config(
        tmp_path,
        "  traversal: { type: file, behavior: domain, format: text, path: ../outside-provider.txt }\n"
        "  symlink: { type: file, behavior: domain, format: text, path: ./escape.txt }\n"
        "  directory: { type: file, behavior: domain, format: text, path: . }\n",
    )

    for name in ("traversal", "symlink", "directory"):
        with pytest.raises(RuleProviderInspectorError) as caught:
            inspect(tmp_path, config, name)
        assert caught.value.code == "provider_path_blocked"
        assert str(outside) not in caught.value.message
    with pytest.raises(RuleProviderInspectorError) as caught:
        inspect(tmp_path, config, "directory", query="x" * 257)
    assert caught.value.code == "query_too_long"


def test_cache_uses_mtime_and_invalidates_after_file_change(tmp_path: Path):
    provider = tmp_path / "provider.txt"
    provider.write_text("one.test\n", encoding="utf-8")
    config = write_config(
        tmp_path,
        "  cached: { type: file, behavior: domain, format: text, path: ./provider.txt }\n",
    )
    clear_rule_provider_inspector_cache()

    first = inspect(tmp_path, config, "cached")
    second = inspect(tmp_path, config, "cached")
    provider.write_text("two.test\n", encoding="utf-8")
    stat = provider.stat()
    os.utime(provider, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
    third = inspect(tmp_path, config, "cached")

    assert first["cache"]["hit"] is False
    assert second["cache"]["hit"] is True
    assert third["cache"]["hit"] is False
    assert third["rules"] == ["two.test"]


def test_mrs_uses_argument_vector_private_temp_and_cache(tmp_path: Path, monkeypatch):
    provider = tmp_path / "semi;colon.mrs"
    provider.write_bytes(b"fixture-mrs")
    binary = tmp_path / "fake mihomo"
    binary.write_text(
        "#!/bin/sh\n"
        "[ \"$1\" = convert-ruleset ] || exit 20\n"
        "[ \"$2\" = domain ] || exit 21\n"
        "[ \"$3\" = mrs ] || exit 22\n"
        "case \"$4\" in */xkeen-mrs-*/provider.mrs) ;; *) exit 23 ;; esac\n"
        "case \"$5\" in */xkeen-mrs-*/rules.pipe) ;; *) exit 25 ;; esac\n"
        "[ \"$(cat \"$4\")\" = fixture-mrs ] || exit 24\n"
        "printf 'example.test\\n+.decoded.test\\n' > \"$5\"\n",
        encoding="utf-8",
    )
    binary.chmod(0o755)
    config = write_config(
        tmp_path,
        "  binary: { type: file, behavior: domain, format: mrs, path: 'semi;colon.mrs' }\n",
    )
    monkeypatch.setattr(inspector_service.tempfile, "tempdir", str(tmp_path))
    clear_rule_provider_inspector_cache()

    first = inspect(tmp_path, config, "binary", mihomo_binary=str(binary))
    binary.unlink()
    second = inspect(tmp_path, config, "binary", mihomo_binary=str(binary))

    assert first["rules"] == ["example.test", "+.decoded.test"]
    assert first["cache"]["hit"] is False
    assert second["cache"]["hit"] is True
    assert not list(tmp_path.glob("xkeen-mrs-*"))


def test_mrs_converter_output_is_bounded_before_it_reaches_disk(tmp_path: Path, monkeypatch):
    provider = tmp_path / "provider.mrs"
    provider.write_bytes(b"fixture-mrs")
    binary = tmp_path / "fake-mihomo"
    binary.write_text(
        "#!/bin/sh\n"
        "head -c 4096 /dev/zero | tr '\\0' x > \"$5\"\n",
        encoding="utf-8",
    )
    binary.chmod(0o755)
    config = write_config(
        tmp_path,
        "  binary: { type: file, behavior: domain, format: mrs, path: provider.mrs }\n",
    )
    monkeypatch.setattr(inspector_service, "MAX_CONVERTED_BYTES", 128)
    monkeypatch.setattr(inspector_service.tempfile, "tempdir", str(tmp_path))

    with pytest.raises(RuleProviderInspectorError) as caught:
        inspect(tmp_path, config, "binary", mihomo_binary=str(binary))

    assert caught.value.code == "mrs_output_too_large"
    assert not list(tmp_path.glob("xkeen-mrs-*"))


def test_source_and_page_limits_are_reported(tmp_path: Path):
    payload = "\n".join(f"      - rule-{index}" for index in range(MAX_RULES + 5))
    config = write_config(
        tmp_path,
        "  many:\n    type: inline\n    behavior: domain\n    payload:\n" + payload + "\n",
    )
    body = inspect(tmp_path, config, "many", limit=9999, offset=MAX_RULES - 2)

    assert body["limit"] == 500
    assert body["total_rules"] == MAX_RULES + 1
    assert body["rules"] == [f"rule-{MAX_RULES - 2}", f"rule-{MAX_RULES - 1}"]
    assert body["truncated"] is True


def test_single_rule_length_is_bounded(tmp_path: Path):
    provider = tmp_path / "provider.txt"
    provider.write_text("x" * 4097, encoding="utf-8")
    config = write_config(
        tmp_path,
        "  long: { type: file, behavior: domain, format: text, path: provider.txt }\n",
    )

    with pytest.raises(RuleProviderInspectorError) as caught:
        inspect(tmp_path, config, "long")

    assert caught.value.code == "provider_rule_too_long"
