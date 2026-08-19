from pathlib import Path


INSTALLER = Path("xkeen-ui/install.sh")
UPDATER = Path("xkeen-ui/scripts/update_xkeen_ui.sh")


def test_installer_isolates_python_cache_before_first_python_process():
    text = INSTALLER.read_text(encoding="utf-8")

    prefix = 'PYTHONPYCACHEPREFIX="${XKEEN_UI_PYTHONPYCACHEPREFIX:-/tmp/xkeen-ui-pycache}"'
    assert prefix in text
    assert text.index(prefix) < text.index('"$PYTHON_BIN" -c')
    assert "export PYTHONPYCACHEPREFIX" in text


def test_generated_init_script_isolates_panel_runtime_python_cache():
    text = INSTALLER.read_text(encoding="utf-8")
    init_script = text.split("cat > \"$INIT_SCRIPT\" << 'EOF'", 1)[1]

    assert 'PYTHONPYCACHEPREFIX="${XKEEN_UI_PYTHONPYCACHEPREFIX:-/tmp/xkeen-ui-pycache}"' in init_script
    assert "export PYTHONPYCACHEPREFIX" in init_script
    assert 'mkdir -p "$PYTHONPYCACHEPREFIX" 2>/dev/null || true' in init_script
    assert init_script.index("export PYTHONPYCACHEPREFIX") < init_script.index('nohup "$PYTHON_BIN" "$TARGET"')


def test_self_update_isolates_cache_before_first_python_helper():
    text = UPDATER.read_text(encoding="utf-8")

    prefix = 'PYTHONPYCACHEPREFIX="${XKEEN_UI_PYTHONPYCACHEPREFIX:-/tmp/xkeen-ui-pycache}"'
    first_helper = '"$PY" - "$STATUS_FILE"'
    assert prefix in text
    assert text.index(prefix) < text.index(first_helper)
    assert "export PYTHONPYCACHEPREFIX" in text


def test_frontend_cleanup_failure_is_non_fatal_under_set_e():
    text = INSTALLER.read_text(encoding="utf-8")

    cleanup = text.split("cleanup_frontend_build_dir() {", 1)[1].split(
        "extract_env_numeric_field() {", 1
    )[0]
    assert 'if CLEANUP_OUTPUT="$(' in cleanup
    assert ")\"; then\n    CLEANUP_STATUS=0\n  else\n    CLEANUP_STATUS=$?" in cleanup
    assert 'frontend-build cleanup failed for $BUILD_DIR' in cleanup
    assert "return 0" in cleanup
