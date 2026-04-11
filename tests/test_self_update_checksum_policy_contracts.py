from pathlib import Path


def test_checksum_policy_defaults_are_strict_and_consistent():
    security_text = Path("xkeen-ui/services/self_update/security.py").read_text(encoding="utf-8")
    env_text = Path("xkeen-ui/services/devtools/env.py").read_text(encoding="utf-8")
    devtools_text = Path("xkeen-ui/routes/devtools.py").read_text(encoding="utf-8")
    runner_text = Path("xkeen-ui/scripts/update_xkeen_ui.sh").read_text(encoding="utf-8")

    assert '"sha_strict": str(os.environ.get("XKEEN_UI_UPDATE_SHA_STRICT") or "1")' in security_text
    assert '"require_sha": str(os.environ.get("XKEEN_UI_UPDATE_REQUIRE_SHA") or "1")' in security_text
    assert 'if k == "XKEEN_UI_UPDATE_SHA_STRICT":' in env_text
    assert 'if k == "XKEEN_UI_UPDATE_REQUIRE_SHA":' in env_text
    assert 'return "1"' in env_text
    assert 'if str(os.environ.get("XKEEN_UI_UPDATE_REQUIRE_SHA") or "1").strip() == "1":' in devtools_text
    assert 'REQUIRE_SHA="${XKEEN_UI_UPDATE_REQUIRE_SHA:-1}"' in runner_text
    assert 'if [ "$CHANNEL" = "stable" ] && [ "$REQUIRE_SHA" = "1" ] && [ -z "${SHA_URL:-}" ]; then' in runner_text
