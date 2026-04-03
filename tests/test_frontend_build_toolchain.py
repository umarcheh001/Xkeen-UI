from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_JSON = ROOT / 'package.json'
PACKAGE_LOCK = ROOT / 'package-lock.json'
VITE_CONFIG = ROOT / 'vite.config.mjs'
VERIFY_SCRIPT = ROOT / 'scripts' / 'verify_frontend_build.mjs'
VENDOR_SYNC_SCRIPT = ROOT / 'scripts' / 'sync_frontend_vendor.py'
BUILD_WORKFLOW_DOC = ROOT / 'docs' / 'frontend-build-workflow.md'
RAW_BUILD_MANIFEST = ROOT / 'xkeen-ui' / 'static' / 'frontend-build' / '.vite' / 'manifest.build.json'
CI_WORKFLOW = ROOT / '.github' / 'workflows' / 'ci.yml'
MIGRATION_PLAN_DOC = ROOT / 'docs' / 'README_frontend_migration_plan.md'


def test_frontend_build_toolchain_files_exist_and_are_wired_up():
    assert PACKAGE_JSON.is_file(), 'stage 7 requires a checked-in package.json'
    assert PACKAGE_LOCK.is_file(), 'stage 7 requires a checked-in package-lock.json'
    assert VITE_CONFIG.is_file(), 'stage 7 requires a checked-in vite.config.mjs'
    assert VERIFY_SCRIPT.is_file(), 'stage 7 requires a build verification script'
    assert VENDOR_SYNC_SCRIPT.is_file(), 'stage 7 requires a vendor sync script for runtime importmap assets'
    assert BUILD_WORKFLOW_DOC.is_file(), 'stage 7 workflow must be documented'

    package = json.loads(PACKAGE_JSON.read_text(encoding='utf-8'))
    scripts = package.get('scripts') or {}
    dev_dependencies = package.get('devDependencies') or {}

    frontend_build_script = scripts.get('frontend:build') or ''
    assert scripts.get('frontend:vendor') == 'python scripts/sync_frontend_vendor.py'
    assert 'scripts/sync_frontend_vendor.py' in frontend_build_script
    assert 'vite build --config vite.config.mjs' in frontend_build_script
    assert 'scripts/sync_frontend_build_manifest.py' in frontend_build_script
    assert scripts.get('frontend:verify:static') == 'node scripts/verify_frontend_build.mjs'
    assert scripts.get('frontend:verify') == 'npm run frontend:build && npm run frontend:verify:static'
    assert dev_dependencies.get('vite') == '8.0.3'

    config_text = VITE_CONFIG.read_text(encoding='utf-8')
    assert "manifest: '.vite/manifest.build.json'" in config_text
    assert "outDir: path.resolve(staticRoot, 'frontend-build')" in config_text
    assert "emptyOutDir: false" in config_text


def test_frontend_build_verifier_passes_when_raw_manifest_exists():
    if shutil.which('node') is None:
        pytest.skip('node is not available in this environment')
    if not RAW_BUILD_MANIFEST.is_file():
        pytest.skip('raw build manifest is not present yet; run npm run frontend:build to generate it')

    result = subprocess.run(
        ['node', str(VERIFY_SCRIPT)],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert 'Frontend build bridge + raw build manifests verified, including required vendor assets.' in result.stdout


def test_frontend_build_ci_and_status_docs_are_closed():
    workflow_text = CI_WORKFLOW.read_text(encoding='utf-8')
    assert 'uses: actions/setup-node@' in workflow_text
    assert 'node-version:' in workflow_text
    assert 'npm ci' in workflow_text
    assert 'npm run frontend:build' in workflow_text
    assert 'verify_frontend_build.mjs' in workflow_text

    readme_text = BUILD_WORKFLOW_DOC.read_text(encoding='utf-8')
    assert 'ci.yml' in readme_text
    assert 'build-user-archive.yml' in readme_text
    assert 'npm ci' in readme_text
    assert 'npm run frontend:build' in readme_text
    assert 'python -m pytest -q' in readme_text
    assert 'npm run frontend:verify' in readme_text
    assert 'sync_frontend_vendor.py' in readme_text
    assert 'sync_frontend_build_manifest.py' in readme_text
    assert 'verify_frontend_build.mjs' in readme_text
    assert 'python-ui-ci.yml' not in readme_text
    assert 'CI выполняет `npm ci` и `npm run frontend:verify`' not in readme_text
