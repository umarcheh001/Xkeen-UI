from pathlib import Path


def test_install_script_supports_pip_mirror_fallbacks_for_flask_and_gevent():
    text = Path("xkeen-ui/install.sh").read_text(encoding="utf-8")

    assert 'PIP_FALLBACK_INDEX_DEFAULT="https://mirrors.aliyun.com/pypi/simple/"' in text
    assert 'GEVENT_PIP_SPEC="${XKEEN_GEVENT_PIP_SPEC:-gevent}"' in text
    assert 'GEVENT_PIP_SPEC="gevent<26"' in text
    assert 'append_pip_index_candidate "${XKEEN_PIP_INDEX_URL:-}"' in text
    assert 'append_pip_index_candidate "$PIP_PRIMARY_INDEX_DEFAULT"' in text
    assert 'append_pip_index_candidate "${XKEEN_PIP_FALLBACK_INDEX_URL:-$PIP_FALLBACK_INDEX_DEFAULT}"' in text
    assert 'pip_install_with_fallback "bootstrap" pip setuptools wheel' in text
    assert 'pip_install_with_fallback "flask" flask' in text
    assert 'pip_install_with_fallback "gevent" "$GEVENT_PIP_SPEC" gevent-websocket' in text
    assert 'XKEEN_PIP_INDEX_URL=$PIP_FALLBACK_INDEX_DEFAULT sh install.sh' in text
    assert 'export XKEEN_GEVENT_PIP_SPEC=${XKEEN_GEVENT_PIP_SPEC:-$GEVENT_PIP_SPEC}' in text


def test_install_script_repairs_entware_pip_truststore_failures():
    text = Path("xkeen-ui/install.sh").read_text(encoding="utf-8")

    assert "PIP_REPAIR_ATTEMPTED=0" in text
    assert "repair_python3_pip_package() {" in text
    assert "pip_failure_needs_repair() {" in text
    assert 'grep -Fq "load_verify_locations(certifi.where())"' in text
    assert 'grep -Fq "/pip/_vendor/truststore/"' in text
    assert "Повторяю pip install после ремонта python3-pip" in text
    assert 'repair_python3_pip_package "pip падает при SSL truststore/certifi или модуль pip поврежден"' in text


def test_install_script_refreshes_bundled_xray_templates_without_touching_custom_names():
    text = Path("xkeen-ui/install.sh").read_text(encoding="utf-8")

    assert 'sync_bundled_template_dir() {' in text
    assert 'for f in "$src_dir"/*.json "$src_dir"/*.jsonc; do' in text
    assert 'if [ -f "$dest" ] && cmp -s "$f" "$dest" 2>/dev/null; then' in text
    assert 'cp -f "$dest" "$dest.dist-$TS" 2>/dev/null || true' in text
    assert 'sync_bundled_template_dir "$SRC_XRAY_ROUTING_TEMPLATES" "$XRAY_ROUTING_TEMPLATES_DIR"' in text
    assert 'sync_bundled_template_dir "$SRC_XRAY_OBSERVATORY_TEMPLATES" "$XRAY_OBSERVATORY_TEMPLATES_DIR"' in text


def test_install_script_jsonc_migration_leaves_unpaired_user_files_in_configs():
    text = Path("xkeen-ui/install.sh").read_text(encoding="utf-8")

    assert 'main_json="${src%?}"' in text
    assert 'if [ ! -f "$main_json" ]; then' in text
    assert 'SKIPPED=$((SKIPPED + 1))' in text
    assert 'skipped=$SKIPPED jsonc_dir=$JSONC_DIR' in text
