# Core Source Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Xray and Mihomo their own safe UI for selecting a curated source profile and installing its latest verified stable release with automatic rollback.

**Architecture:** Each engine owns a fixed profile catalog, engine-scoped API and frontend adapter. Shared services resolve release assets, persist selected/installed state, and execute a locked installation transaction; the browser never supplies repository URLs, filenames, shell commands or checksums. Installation is allowed only when that engine is currently active, so successful status always includes the required restart and health-check.

**Tech Stack:** Python 3, Flask blueprints, GitHub REST API via `urllib`, Python `gzip`/`zipfile`, JSON state, native ESM, Jinja templates, CSS, pytest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-30-core-source-selection-design.md`

## Global Constraints

- First release accepts only stable releases from the versioned curated profile catalog.
- The catalog is exactly: Xray `XTLS/Xray-core`, `MakostaDev/UwuRay`, `GFW-knocker/Xray-core`; Mihomo `MetaCubeX/mihomo`, `LOVECHEN/mihomo-enhanced`, `legiz-ru/Prizrak-Core`.
- The client sends only `engine_id`, `profile_id` and server-issued `plan_id`; it never sends an external URL, filename, hash or shell command.
- Installation is impossible without a matching SHA-256 checksum obtained from release assets.
- `selected_profile_id` and `installed_profile_id` are separate persisted fields. Selecting a profile must not replace a binary.
- Install only the currently active engine. The transaction must run preflight, restart and health-check before recording a new installed profile.
- Preserve `/opt/sbin/xray` and `/opt/sbin/mihomo` as binary locations; profile-specific asset names do not change the executable name.
- Before replacement, save both binary and state metadata below the trusted UI state directory. On any failure after backup, restore both atomically.
- Retain `xkeen -ux` and `xkeen -um` in the command catalog. Remove their competing status-card update actions; the engine cards become the primary UI.
- All user-facing error/status copy is Russian. Add no arbitrary repository advanced mode in this work.

---

## File Structure

| File | Responsibility |
|---|---|
| `xkeen-ui/services/core_profiles.py` | Immutable profile catalog, router platform detection, GitHub stable-release lookup, checksum parsing, asset resolution. |
| `xkeen-ui/services/core_profile_state.py` | Validated JSON persistence for selected/installed profile state, release cache and backup metadata. |
| `xkeen-ui/services/core_installer.py` | Locked prepare/apply/status transaction, download, verification, backup, replacement, preflight, restart, health-check and rollback. |
| `xkeen-ui/routes/core_profiles.py` | Builds two engine-scoped Flask blueprints over the shared services; validates request payloads and serializes responses. |
| `xkeen-ui/routes/__init__.py` | Registers Xray and Mihomo source blueprints behind their existing module activation gates. |
| `xkeen-ui/templates/panel/core_source.html` | Shared Jinja macro for compact engine card and accessible source/install modals. |
| `xkeen-ui/templates/panel/screens/xray_core_source.html` | Xray-owned include that invokes the shared macro with `engine_id='xray'`. |
| `xkeen-ui/templates/panel/screens/mihomo_core_source.html` | Mihomo-owned include that invokes the shared macro with `engine_id='mihomo'`. |
| `xkeen-ui/templates/panel/screens/routing.html` | Includes Xray control at the top of the Xray screen. |
| `xkeen-ui/templates/panel.html` | Includes Mihomo control at the top of the current Mihomo surface and removes legacy update buttons from Commands. |
| `xkeen-ui/static/js/features/core_source_ui.js` | Reusable ESM controller for one engine's source-selection flow. |
| `xkeen-ui/static/js/features/xray_core_source.js` | Thin Xray module adapter calling `initCoreSourceUi({ engine: 'xray' })`. |
| `xkeen-ui/static/js/features/mihomo_core_source.js` | Thin Mihomo module adapter calling `initCoreSourceUi({ engine: 'mihomo' })`. |
| `xkeen-ui/static/js/pages/panel.routing.bundle.js` | Loads only the Xray adapter. |
| `xkeen-ui/static/js/pages/panel.mihomo.bundle.js` | Loads only the Mihomo adapter. |
| `xkeen-ui/static/styles.css` | Base styles and responsive layout for the engine card, profile list, confirmation and operation progress. |
| `xkeen-ui/static/panel-operator.css` | Operator-theme equivalents of the new control and modal states. |
| `xkeen-ui/static/js/features/cores_status.js` | Retains read-only legacy version/release links but stops wiring status-card update actions. |
| `tests/test_core_profiles.py` | Catalog, platform, stable release, asset and checksum resolver unit tests. |
| `tests/test_core_profile_state.py` | Selected-vs-installed JSON state, cache and trusted-path tests. |
| `tests/test_core_installer.py` | Transaction success, each failure edge and rollback tests with fake download/process runners. |
| `tests/test_core_profiles_api.py` | Engine isolation, selection persistence, preparation, active-engine guard and parallel-operation API tests. |
| `tests/test_core_source_ui_contract.py` | Static template/bundle/module-ownership regression tests. |
| `tests/test_cores_status_prereleases.py` | Updates the legacy Commands status expectations after its actions are removed. |
| `e2e/core_source_selection.spec.mjs` | Browser flow with mocked engine endpoints: select-only, confirmation, operation progress, stale and rollback UI. |

## Shared Interfaces

All later tasks use these exact types and names:

```python
# services/core_profiles.py
@dataclass(frozen=True)
class CoreProfile:
    profile_id: str
    engine_id: Literal['xray', 'mihomo']
    repo: str
    display_name: str
    description: str
    risk_level: Literal['official', 'alternative', 'experimental']
    binary_name: str
    release_policy: Literal['stable_only'] = 'stable_only'

@dataclass(frozen=True)
class RouterPlatform:
    machine: str
    opkg_arch: str
    endianness: str

def list_profiles(engine_id: str) -> tuple[CoreProfile, ...]: ...
def get_profile(engine_id: str, profile_id: str) -> CoreProfile: ...
def detect_router_platform() -> RouterPlatform: ...
def resolve_release(profile: CoreProfile, platform: RouterPlatform, *, timeout_s: float) -> dict[str, Any]: ...
```

```python
# services/core_profile_state.py
class CoreProfileStateStore:
    def get_engine_state(self, engine_id: str) -> dict[str, Any]: ...
    def save_selected_profile(self, engine_id: str, profile_id: str) -> dict[str, Any]: ...
    def save_release_cache(self, engine_id: str, profile_id: str, release: dict[str, Any]) -> None: ...
    def save_installed(self, engine_id: str, profile_id: str, version: str, backup: dict[str, Any]) -> None: ...
    def restore_snapshot(self, engine_id: str, snapshot: dict[str, Any]) -> None: ...
```

```python
# services/core_installer.py
class CoreInstaller:
    def get_profiles_view(self, engine_id: str) -> dict[str, Any]: ...
    def select_profile(self, engine_id: str, profile_id: str) -> dict[str, Any]: ...
    def prepare(self, engine_id: str) -> dict[str, Any]: ...
    def apply(self, engine_id: str, plan_id: str) -> dict[str, Any]: ...
    def get_status(self, engine_id: str, operation_id: str | None = None) -> dict[str, Any]: ...
```

`resolve_release()` returns a JSON-safe view with `stable`, `asset`,
`checksum`, `platform`, `installable`, `reason`, `stale`, and `fetched_at`.
`prepare()` returns a short-lived plan with `plan_id`, exact immutable release
metadata and `requires_confirmation=True`. `apply()` starts a background job and
returns `{ 'operation_id': str, 'state': 'running' }`.

### Task 1: Curated Profile Catalog and Release Resolver

**Files:**
- Create: `xkeen-ui/services/core_profiles.py`
- Create: `tests/test_core_profiles.py`

**Interfaces:**
- Consumes: `urllib.request`, `os.uname`, `opkg print-architecture`, `gzip`, `zipfile` naming conventions only.
- Produces: `CoreProfile`, `RouterPlatform`, `list_profiles()`, `get_profile()`, `detect_router_platform()`, `resolve_release()` for state/API/installer tasks.

- [ ] **Step 1: Write catalog, platform and resolver tests before implementation**

```python
def test_catalogs_are_engine_scoped_and_use_stable_ids():
    assert [p.profile_id for p in profiles.list_profiles('xray')] == [
        'official', 'uwuray', 'gfw-knocker',
    ]
    assert [p.profile_id for p in profiles.list_profiles('mihomo')] == [
        'official', 'mihomo-enhanced', 'prizrak-core',
    ]
    with pytest.raises(ValueError, match='Неизвестный профиль'):
        profiles.get_profile('xray', 'mihomo-enhanced')

def test_resolve_mipsle_mihomo_asset_and_checksums_txt(monkeypatch):
    release = _release('v1.19.32', [
        _asset('mihomo-linux-mipsle-softfloat-v1.19.32.gz'),
        _asset('checksums.txt', url='https://example.test/checksums.txt'),
    ])
    monkeypatch.setattr(profiles, '_github_json', lambda *_args, **_kwargs: release)
    monkeypatch.setattr(
        profiles, '_download_text',
        lambda *_args, **_kwargs: 'a' * 64 + '  mihomo-linux-mipsle-softfloat-v1.19.32.gz\n',
    )
    result = profiles.resolve_release(
        profiles.get_profile('mihomo', 'official'),
        profiles.RouterPlatform('mipsel', 'mipsel-3.4', 'le'),
        timeout_s=1,
    )
    assert result['installable'] is True
    assert result['asset']['name'] == 'mihomo-linux-mipsle-softfloat-v1.19.32.gz'
    assert result['checksum']['sha256'] == 'a' * 64

def test_resolve_xray_uses_per_asset_dgst_and_rejects_missing_checksum(monkeypatch):
    release = _release('v26.3.27', [_asset('Xray-linux-mips32le.zip')])
    monkeypatch.setattr(profiles, '_github_json', lambda *_args, **_kwargs: release)
    monkeypatch.setattr(profiles, '_download_text', lambda *_args, **_kwargs: '')
    result = profiles.resolve_release(
        profiles.get_profile('xray', 'official'),
        profiles.RouterPlatform('mipsel', 'mipsel-3.4', 'le'),
        timeout_s=1,
    )
    assert result['installable'] is False
    assert result['reason'] == 'checksum_missing'
```

Add cases for Xray ARM64 asset `Xray-linux-arm64-v8a.zip`, Xray MIPS big-endian
`Xray-linux-mips32.zip`, Mihomo enhanced's `Alpha-<build>` filename,
Prizrak's `prizrak-core-linux-mipsle-softfloat-<tag>.gz`, missing asset and
non-stable/draft releases. Use an HTTP-response stub so tests never contact
GitHub.

- [ ] **Step 2: Run the focused resolver tests to confirm they fail**

Run: `pytest tests/test_core_profiles.py -v`

Expected: FAIL during import because `services.core_profiles` does not exist.

- [ ] **Step 3: Implement immutable catalog and platform detection**

```python
CORE_PROFILES: Final[dict[str, tuple[CoreProfile, ...]]] = {
    'xray': (
        CoreProfile('official', 'xray', 'XTLS/Xray-core', 'Официальный Xray',
                    'Базовая совместимость Xray.', 'official', 'xray'),
        CoreProfile('uwuray', 'xray', 'MakostaDev/UwuRay', 'UwuRay',
                    'Снята проверка минимальной версии клиента REALITY.', 'alternative', 'xray'),
        CoreProfile('gfw-knocker', 'xray', 'GFW-knocker/Xray-core', 'GFW-knocker',
                    'Сборка для MahsaNG; используйте как экспериментальный профиль.', 'experimental', 'xray'),
    ),
    'mihomo': (
        CoreProfile('official', 'mihomo', 'MetaCubeX/mihomo', 'Официальный Mihomo',
                    'Базовая совместимость Mihomo.', 'official', 'mihomo'),
        CoreProfile('mihomo-enhanced', 'mihomo', 'LOVECHEN/mihomo-enhanced', 'mihomo-enhanced',
                    'REALITY client version следует за Xray; добавлены Bridge и Portal.', 'alternative', 'mihomo'),
        CoreProfile('prizrak-core', 'mihomo', 'legiz-ru/Prizrak-Core', 'Prizrak-Core',
                    'Альтернативная сборка Mihomo.', 'experimental', 'mihomo'),
    ),
}
```

Implement platform detection from `os.uname().machine`, `_opkg_primary_arch()`
and `/proc/cpuinfo` with the same conservative MIPS endian fallback used by
the existing Mihomo resolver. Normalize to an explicit internal selector,
never a client-provided string.

- [ ] **Step 4: Implement stable release fetching, asset matching and checksum parsing**

Use `GET /repos/{repo}/releases/latest`; reject a draft or prerelease response.
For Mihomo read `checksums.txt` and match the exact asset basename. For Xray
read the matching `{asset}.dgst` release asset and extract exactly one SHA-256
hex digest. Return `reason` values `unsupported_arch`, `asset_missing`,
`checksum_missing`, `github_unavailable` or `invalid_release`; never return an
installable result without `asset.url`, `checksum.url` and `checksum.sha256`.

```python
def _non_installable(reason: str, platform: RouterPlatform) -> dict[str, Any]:
    return {
        'stable': None,
        'asset': None,
        'checksum': None,
        'platform': asdict(platform),
        'installable': False,
        'reason': reason,
        'stale': False,
        'fetched_at': time.time(),
    }
```

Do not reuse `routes/cores_status.py`'s environment-configurable repository
values: those are a legacy status view and must not authorize installation.

- [ ] **Step 5: Run resolver tests and lint checks**

Run: `pytest tests/test_core_profiles.py -v`

Expected: PASS.

Run: `python -m compileall -q xkeen-ui/services/core_profiles.py`

Expected: exit code 0.

- [ ] **Step 6: Commit catalog/resolver**

```bash
git add xkeen-ui/services/core_profiles.py tests/test_core_profiles.py
git commit -m "feat: add curated core release resolver"
```

### Task 2: Persistent State and Transactional Installer

**Files:**
- Create: `xkeen-ui/services/core_profile_state.py`
- Create: `xkeen-ui/services/core_installer.py`
- Create: `tests/test_core_profile_state.py`
- Create: `tests/test_core_installer.py`

**Interfaces:**
- Consumes: Task 1 profiles/release views; target paths `/opt/sbin/xray`, `/opt/sbin/mihomo`; `restart_xkeen`; `detect_running_core`.
- Produces: `CoreProfileStateStore` and `CoreInstaller` interfaces in the Shared Interfaces section.

- [ ] **Step 1: Write state-store tests**

```python
def test_selection_does_not_change_the_installed_profile(tmp_path):
    store = CoreProfileStateStore(str(tmp_path))
    store.save_installed('mihomo', 'official', '1.19.32', {'backup_id': 'b1'})
    result = store.save_selected_profile('mihomo', 'mihomo-enhanced')
    assert result['selected_profile_id'] == 'mihomo-enhanced'
    assert store.get_engine_state('mihomo')['installed_profile_id'] == 'official'

def test_store_rejects_engine_escape_and_invalid_profile(tmp_path):
    store = CoreProfileStateStore(str(tmp_path))
    with pytest.raises(ValueError):
        store.save_selected_profile('../xray', 'official')
```

Test that JSON writes are atomic, the state file remains below
`<ui_state_dir>/core-profiles/`, invalid/corrupt JSON reads as the documented
empty default rather than raising, and each engine state is isolated.

- [ ] **Step 2: Write transaction tests with deterministic fakes**

```python
def test_apply_replaces_binary_only_after_hash_preflight_restart_and_healthcheck(tmp_path):
    installer, binary = _installer_with_active_xray(tmp_path)
    binary.write_bytes(b'old-xray')
    prepared = installer.prepare('xray')
    accepted = installer.apply('xray', prepared['plan_id'])
    completed = _wait_for_operation(installer, 'xray', accepted['operation_id'])
    assert completed['state'] == 'succeeded'
    assert binary.read_bytes() == b'new-xray'
    assert installer.state.get_engine_state('xray')['installed_profile_id'] == 'uwuray'

@pytest.mark.parametrize('failure_stage', ['download', 'checksum', 'preflight', 'restart', 'healthcheck'])
def test_failure_after_backup_restores_binary_and_installed_metadata(tmp_path, failure_stage):
    installer, binary = _installer_with_active_xray(tmp_path, failure_stage=failure_stage)
    binary.write_bytes(b'known-good')
    installer.state.save_installed('xray', 'official', '26.3.27', {'backup_id': 'old'})
    plan = installer.prepare('xray')
    op = installer.apply('xray', plan['plan_id'])
    result = _wait_for_operation(installer, 'xray', op['operation_id'])
    assert result['state'] == 'rolled_back'
    assert binary.read_bytes() == b'known-good'
    assert installer.state.get_engine_state('xray')['installed_profile_id'] == 'official'
```

Add tests for: apply with expired/foreign plan; no matching checksum; inactive
engine; a second apply while one is running; `.gz` extraction to `mihomo`;
`.zip` extraction of `xray`; file mode is executable; and `status()` does not
leak local backup paths to the browser.

- [ ] **Step 3: Run installer/state tests to verify they fail**

Run: `pytest tests/test_core_profile_state.py tests/test_core_installer.py -v`

Expected: FAIL during import because the state and installer modules do not exist.

- [ ] **Step 4: Implement durable state store with path containment**

Use exactly one JSON document at
`<ui_state_dir>/core-profiles/state.json` and a sibling release cache at
`<ui_state_dir>/core-profiles/release-cache.json`. Validate engine IDs against
`{'xray', 'mihomo'}` before constructing a path. Write via the project atomic
JSON helper (`services.io.atomic._atomic_write_json`) and retain a full state
snapshot before transactional changes.

```python
EMPTY_ENGINE_STATE = {
    'selected_profile_id': 'official',
    'selected_profile_status': 'selected_not_installed',
    'installed_profile_id': None,
    'installed_version': None,
    'backup_metadata': None,
}
```

Never persist download URLs or a raw API request payload as user-controlled
state. Store only validated profile IDs, version/tag, resolved asset basename,
hash, timestamp and backup identifier.

- [ ] **Step 5: Implement prepare/apply transaction and rollback**

Constructor dependencies must be injectable for tests:

```python
CoreInstaller(
    state: CoreProfileStateStore,
    *,
    binary_paths: Mapping[str, str],
    xray_confdir: str,
    mihomo_config_file: str,
    restart_xkeen: Callable[[], bool],
    running_core: Callable[[], str | None],
    release_resolver: Callable[..., dict[str, Any]] = resolve_release,
    download_bytes: Callable[[str, float], bytes] = _download_bytes,
    process_runner: Callable[[list[str], float], tuple[int, str]] = _run_process,
)
```

`prepare()` resolves the selected profile, writes fresh release cache, rejects
stale/uninstallable results and records a 10-minute in-memory plan bound to its
engine/profile/release/asset/hash. `apply()` rejects a plan not belonging to
that engine, an expired plan or a non-active engine with code
`active_engine_required`; it starts a daemon worker and returns promptly.

The worker must update operation state after every completed phase. Download
into a `tempfile.TemporaryDirectory` below `<ui_state_dir>/core-profiles/tmp`.
Verify SHA-256 before extracting. Extract `.gz` using `gzip.open`; extract only
the named `xray` member from a zip using `zipfile.ZipFile`, rejecting absolute
paths and archive members outside the expected basename. Write extracted bytes
to a same-filesystem temporary file beside the binary, set `0o755`, `fsync`,
then `os.replace`.

Create a timestamped backup directory below
`<ui_state_dir>/core-profiles/backups/<engine>/<operation_id>/`, copy the old
binary with `shutil.copy2`, save a state snapshot, and set operation phase
`backup` before replacement. Perform:

```python
preflight = (
    [binary_path, '-test', '-confdir', xray_confdir]
    if engine_id == 'xray'
    else [binary_path, '-t', '-f', mihomo_config_file]
)
```

After a successful preflight call `restart_xkeen()`, then require
`running_core() == engine_id` before committing state. Any exception after
backup invokes rollback: atomically restore backup binary, restore the state
snapshot, call `restart_xkeen()` once more, and expose `state='rolled_back'`
with a phase-specific Russian message. An exception before backup exposes
`state='failed'` and changes nothing.

- [ ] **Step 6: Run focused state/transaction tests**

Run: `pytest tests/test_core_profile_state.py tests/test_core_installer.py -v`

Expected: PASS.

Run: `python -m compileall -q xkeen-ui/services/core_profile_state.py xkeen-ui/services/core_installer.py`

Expected: exit code 0.

- [ ] **Step 7: Commit state and transaction**

```bash
git add xkeen-ui/services/core_profile_state.py xkeen-ui/services/core_installer.py tests/test_core_profile_state.py tests/test_core_installer.py
git commit -m "feat: install curated core releases safely"
```

### Task 3: Module-Owned Core Source API

**Files:**
- Create: `xkeen-ui/routes/core_profiles.py`
- Modify: `xkeen-ui/routes/__init__.py`
- Create: `tests/test_core_profiles_api.py`

**Interfaces:**
- Consumes: Task 1 profile catalog, Task 2 `CoreProfileStateStore` and `CoreInstaller`, `AppContext` values already supplied to blueprint registration.
- Produces: two gated blueprints and the six paths defined in the spec.

- [ ] **Step 1: Write API integration tests**

```python
def test_xray_profiles_do_not_expose_mihomo_catalog(client):
    payload = client.get('/api/xray/core-profiles').get_json()
    assert payload['engine_id'] == 'xray'
    assert {p['profile_id'] for p in payload['profiles']} == {'official', 'uwuray', 'gfw-knocker'}
    assert 'mihomo-enhanced' not in {p['profile_id'] for p in payload['profiles']}

def test_source_selection_persists_without_starting_install(client, fake_installer):
    response = client.post('/api/mihomo/core-source', json={'profile_id': 'mihomo-enhanced'})
    assert response.status_code == 200
    assert response.get_json()['state']['selected_profile_id'] == 'mihomo-enhanced'
    assert fake_installer.apply_calls == []

def test_prepare_and_apply_require_server_issued_plan(client, fake_installer):
    prepared = client.post('/api/xray/core-install/prepare').get_json()
    assert prepared['requires_confirmation'] is True
    response = client.post('/api/xray/core-install/apply', json={'plan_id': prepared['plan_id']})
    assert response.status_code == 202
    assert response.get_json()['state'] == 'running'
```

Cover 400 invalid JSON/profile ID, 409 inactive/locked install and a status request
for the wrong engine/operation. Construct a Flask test app with only the new
blueprints and inject a fake installer so it cannot touch router paths.

- [ ] **Step 2: Run API tests to confirm they fail**

Run: `pytest tests/test_core_profiles_api.py -v`

Expected: FAIL during import because `routes.core_profiles` does not exist.

- [ ] **Step 3: Build source blueprints and wire them behind engine gates**

Implement a single factory with an explicit engine argument and stable blueprint
names, then public wrappers:

```python
def create_xray_core_profiles_blueprint(installer: CoreInstaller) -> Blueprint:
    return _create_core_profiles_blueprint('xray', installer)

def create_mihomo_core_profiles_blueprint(installer: CoreInstaller) -> Blueprint:
    return _create_core_profiles_blueprint('mihomo', installer)
```

Routes must compare the URL engine captured by the blueprint to the service
result, whitelist body keys, reject non-string `profile_id`/`plan_id`, and use
the existing JSON error style with `code` and Russian `message`. Return 202 only
after a background operation was accepted. `GET status` must accept optional
`operation_id` and return sanitized status only.

In `routes/__init__.py`, create one shared installer per Flask application using
`ctx.ui_state_dir`, `ctx.xray_configs_dir`, `ctx.mihomo_config_file`,
`ctx.restart_xkeen`, `services.cores.detect_running_core`, and fixed binary
paths. Register the Xray blueprint within `if module_active('engine.xray'):` and
the Mihomo blueprint within `if module_active('engine.mihomo'):`. Do not register
either from the always-active `cores_status` blueprint.

- [ ] **Step 4: Run API and module-gating regression tests**

Run: `pytest tests/test_core_profiles_api.py tests/test_module_backend_gates.py -v`

Expected: PASS.

- [ ] **Step 5: Commit the module-owned API**

```bash
git add xkeen-ui/routes/core_profiles.py xkeen-ui/routes/__init__.py tests/test_core_profiles_api.py
git commit -m "feat: expose engine core source APIs"
```

### Task 4: Engine-Owned Cards, Modals and Legacy Commands Migration

**Files:**
- Create: `xkeen-ui/templates/panel/core_source.html`
- Create: `xkeen-ui/templates/panel/screens/xray_core_source.html`
- Create: `xkeen-ui/templates/panel/screens/mihomo_core_source.html`
- Modify: `xkeen-ui/templates/panel/screens/routing.html`
- Modify: `xkeen-ui/templates/panel.html`
- Modify: `xkeen-ui/static/styles.css`
- Modify: `xkeen-ui/static/panel-operator.css`
- Modify: `xkeen-ui/static/js/features/cores_status.js`
- Modify: `tests/test_cores_status_prereleases.py`
- Create: `tests/test_core_source_ui_contract.py`

**Interfaces:**
- Consumes: Task 3 paths and API response shape; existing `op_icon` macro and panel modal conventions.
- Produces: exact DOM IDs consumed by Task 5, one engine card and two accessible modals per engine.

- [ ] **Step 1: Write static template and migration regression tests**

```python
def test_each_engine_owns_one_core_source_control_and_bundle_import():
    xray = (ROOT / 'xkeen-ui/templates/panel/screens/xray_core_source.html').read_text(encoding='utf-8')
    mihomo = (ROOT / 'xkeen-ui/templates/panel/screens/mihomo_core_source.html').read_text(encoding='utf-8')
    assert "engine_id='xray'" in xray
    assert "engine_id='mihomo'" in mihomo
    assert "xray_core_source" in (ROOT / 'xkeen-ui/static/js/pages/panel.routing.bundle.js').read_text(encoding='utf-8')
    assert "mihomo_core_source" in (ROOT / 'xkeen-ui/static/js/pages/panel.mihomo.bundle.js').read_text(encoding='utf-8')

def test_commands_keep_low_level_flags_but_not_competing_core_update_buttons():
    panel = (ROOT / 'xkeen-ui/templates/panel.html').read_text(encoding='utf-8')
    catalog = (ROOT / 'xkeen-ui/services/xkeen_commands_catalog.py').read_text(encoding='utf-8')
    assert '"-ux"' in catalog and '"-um"' in catalog
    assert 'id="core-xray-update-btn"' not in panel
    assert 'id="core-mihomo-update-btn"' not in panel
```

Assert each source modal has `role="dialog"`, `aria-modal="true"`, a labelled
title, a close control, profile list `role="radiogroup"`, a disabled install
action until preparation, and a live operation region. Assert CSS contains the
mobile single-column media rule and operator-theme selector.

- [ ] **Step 2: Run static UI tests to confirm they fail**

Run: `pytest tests/test_core_source_ui_contract.py tests/test_cores_status_prereleases.py -v`

Expected: FAIL because the source controls and migration do not exist; update
existing expectations that currently require status-card update buttons.

- [ ] **Step 3: Add shared macro and thin engine-owned includes**

`core_source.html` defines exactly one macro:

```jinja2
{% macro render_core_source(engine_id, engine_label) -%}
<section class="card xk-core-source-card" data-core-source-engine="{{ engine_id }}">
  <div class="xk-core-source-summary">
    <span class="xk-core-source-name">{{ engine_label }}</span>
    <span data-core-source-version>—</span>
    <span data-core-source-installed>Проверка источника</span>
  </div>
  <div class="xk-core-source-actions">
    <button type="button" class="btn-secondary" data-core-source-action="open">{{ op_icon('settings') }}<span>Источник</span></button>
    <button type="button" class="btn-primary" data-core-source-action="prepare" disabled>{{ op_icon('download') }}<span>Обновить</span></button>
  </div>
</section>
{%- endmacro %}
```

The macro also renders engine-prefixed source and confirmation modals so IDs are
unique, such as `xray-core-source-modal`, `xray-core-install-modal`,
`mihomo-core-source-modal`, and `mihomo-core-install-modal`. Render profiles
at runtime; do not embed a second hardcoded catalog in HTML.

Include the Xray partial immediately after `#view-routing` starts in
`routing.html`. Include the Mihomo partial directly inside `#view-mihomo`, above
`#mihomo-clash-runtime`, so it remains with the engine rather than Commands.

- [ ] **Step 4: Migrate legacy Commands status actions safely**

Remove stable and prerelease `core-*-update-btn` controls from the Commands
status panel while preserving installed version, GitHub release links, stale
state and `cores-check-btn`. Delete only the action wiring in
`cores_status.js`; preserve read-only `/api/cores/versions` and
`/api/cores/updates` refresh logic. Keep `-ux` and `-um` in the command catalog
unchanged. Rewrite the relevant assertions in
`test_cores_status_prereleases.py` to verify release rendering without action
buttons and the continuing command catalog flags.

- [ ] **Step 5: Style the card, profile list, confirmation and progress states**

Use a compact operational layout: a single unframed status strip within the
engine screen, two fixed-height action buttons, and modals with one profile
list at a time. Profile rows are selectable with radio semantics, display the
repository, description, stable tag/date, checksum state, asset state and an
external GitHub link. Disabled rows retain their reason. The confirmation modal
lists the exact tag, asset basename, SHA-256 and automatic-backup message.

Use CSS custom properties already defined by the panel. Add base classes in
`styles.css`, operator overrides in `panel-operator.css`, and media rules that
stack card actions and modal facts at narrow widths. Do not use gradients,
rounded decorative cards or bare textual icon substitutes.

- [ ] **Step 6: Run static/frontend build verification**

Run: `pytest tests/test_core_source_ui_contract.py tests/test_cores_status_prereleases.py -v`

Expected: PASS.

Run: `npm run frontend:build`

Expected: production build succeeds with no unresolved imports.

- [ ] **Step 7: Commit UI structure and Commands migration**

```bash
git add xkeen-ui/templates/panel/core_source.html xkeen-ui/templates/panel/screens/xray_core_source.html xkeen-ui/templates/panel/screens/mihomo_core_source.html xkeen-ui/templates/panel/screens/routing.html xkeen-ui/templates/panel.html xkeen-ui/static/styles.css xkeen-ui/static/panel-operator.css xkeen-ui/static/js/features/cores_status.js tests/test_core_source_ui_contract.py tests/test_cores_status_prereleases.py
git commit -m "feat: add core source selection surfaces"
```

### Task 5: Engine Frontend Controllers

**Files:**
- Create: `xkeen-ui/static/js/features/core_source_ui.js`
- Create: `xkeen-ui/static/js/features/xray_core_source.js`
- Create: `xkeen-ui/static/js/features/mihomo_core_source.js`
- Modify: `xkeen-ui/static/js/pages/panel.routing.bundle.js`
- Modify: `xkeen-ui/static/js/pages/panel.mihomo.bundle.js`
- Modify: `tests/test_core_source_ui_contract.py`

**Interfaces:**
- Consumes: Task 4 `data-core-source-*` DOM contract and Task 3 API contract.
- Produces: `initCoreSourceUi({ engine: 'xray' | 'mihomo' })`, module-owned adapters and predictable modal/operation behavior.

- [ ] **Step 1: Extend static controller-contract tests**

```python
def test_controller_uses_engine_scoped_api_and_never_accepts_external_source_values():
    script = (ROOT / 'xkeen-ui/static/js/features/core_source_ui.js').read_text(encoding='utf-8')
    assert "`/api/${engine}/core-profiles`" in script
    assert "`/api/${engine}/core-source`" in script
    assert "profile_id" in script
    assert 'repo_url' not in script
    assert 'asset_url' not in script
    assert 'shell' not in script
```

Assert adapters are thin engine constants and that each page bundle imports only
its owner adapter. Assert operation polling is bounded and cleared when the
operation reaches `succeeded`, `failed` or `rolled_back`.

- [ ] **Step 2: Run controller-contract test to confirm it fails**

Run: `pytest tests/test_core_source_ui_contract.py -v`

Expected: FAIL because the controller and adapters do not exist.

- [ ] **Step 3: Implement the generic controller with engine-only configuration**

```javascript
export function initCoreSourceUi({ engine }) {
  if (!['xray', 'mihomo'].includes(engine)) return null;
  const apiBase = `/api/${engine}`;
  // Query only [data-core-source-engine="${engine}"] and its prefixed modal IDs.
}
```

On initialization, request profiles, render server-provided facts and keep the
install button disabled until the selected profile is saved and `installable` is
true. Selecting a radio updates local pending selection only. "Сохранить выбор"
posts `{ profile_id }`, refreshes the card, and explicitly labels it as selected
but not installed.

"Обновить" posts to `core-install/prepare`, opens confirmation only when the
response has `requires_confirmation`, and fills tag/asset/hash from the server
response using `textContent`. "Установить" posts only `{ plan_id }`, disables
all mutation controls, polls `/core-install/status?operation_id=...` every 800
ms for at most 10 minutes, and renders only the returned completed phases.
Terminal state must restore controls and show `rolled_back` in an alert-style
status without ever changing the installed card optimistically.

Implement click close, Escape close, focus return to opener, and modal
backdrop behavior consistent with current panel modal helpers. Render GitHub
links only from server fields with `rel="noopener"` and `target="_blank"`.

- [ ] **Step 4: Add module adapters and bundle imports**

```javascript
// features/xray_core_source.js
import { initCoreSourceUi } from './core_source_ui.js';
initCoreSourceUi({ engine: 'xray' });

// features/mihomo_core_source.js
import { initCoreSourceUi } from './core_source_ui.js';
initCoreSourceUi({ engine: 'mihomo' });
```

Import the first only from `panel.routing.bundle.js` and the second only from
`panel.mihomo.bundle.js`. Do not add a `window.XKeen` bridge.

- [ ] **Step 5: Run contract and frontend build tests**

Run: `pytest tests/test_core_source_ui_contract.py -v`

Expected: PASS.

Run: `npm run frontend:build`

Expected: PASS.

- [ ] **Step 6: Commit frontend controllers**

```bash
git add xkeen-ui/static/js/features/core_source_ui.js xkeen-ui/static/js/features/xray_core_source.js xkeen-ui/static/js/features/mihomo_core_source.js xkeen-ui/static/js/pages/panel.routing.bundle.js xkeen-ui/static/js/pages/panel.mihomo.bundle.js tests/test_core_source_ui_contract.py
git commit -m "feat: wire engine core source controls"
```

### Task 6: Browser Coverage and Full Verification

**Files:**
- Create: `e2e/core_source_selection.spec.mjs`
- Modify: `playwright.config.mjs` only if the existing project match/exclude rules do not discover the new spec.

**Interfaces:**
- Consumes: completed API/UI contract from Tasks 1-5 and existing Playwright fixtures.
- Produces: regression coverage across desktop and mobile without live GitHub/router dependency.

- [ ] **Step 1: Write Playwright scenarios with all backend calls mocked**

```javascript
test('selecting an alternative profile does not claim it is installed', async ({ page }) => {
  await mockCoreSourceApi(page, 'mihomo', { selected: 'official', installed: 'official' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Источник' }).filter({ has: page.locator('[data-core-source-engine="mihomo"]') }).click();
  await page.getByRole('radio', { name: /mihomo-enhanced/ }).check();
  await page.getByRole('button', { name: 'Сохранить выбор' }).click();
  await expect(page.locator('[data-core-source-engine="mihomo"]')).toContainText('Выбран, не установлен');
  await expect(page.locator('[data-core-source-engine="mihomo"]')).toContainText('Официальный Mihomo');
});

test('confirmation displays exact verified asset before apply', async ({ page }) => {
  await mockCoreSourceApi(page, 'xray', { prepared: verifiedXrayPlan });
  await page.goto('/');
  await page.locator('[data-core-source-engine="xray"] [data-core-source-action="prepare"]').click();
  await expect(page.locator('#xray-core-install-modal')).toContainText('Xray-linux-mips32le.zip');
  await expect(page.locator('#xray-core-install-modal')).toContainText(verifiedXrayPlan.checksum.sha256);
});
```

Add scenarios for unavailable checksum (button remains disabled with a reason),
stale data (marked stale; no automatic apply), operation phase rendering,
rollback restoring prior installed profile and no horizontal overflow at 390 px
and 1280 px. Use a separate test for Xray and Mihomo to prove catalogs do not
mix.

- [ ] **Step 2: Run the new spec to confirm it fails**

Run: `npx playwright test e2e/core_source_selection.spec.mjs --project=chromium`

Expected: FAIL because the feature is not fully wired or selectors are absent.

- [ ] **Step 3: Make selector/accessibility adjustments required by the failing browser tests**

Keep corrections inside Task 4 templates/styles and Task 5 controller only. Do
not weaken test assertions, skip the mobile scenario or replace user-facing
roles with implementation-only selectors.

- [ ] **Step 4: Run focused backend, frontend and E2E suites**

Run:

```bash
pytest tests/test_core_profiles.py tests/test_core_profile_state.py tests/test_core_installer.py tests/test_core_profiles_api.py tests/test_core_source_ui_contract.py tests/test_cores_status_prereleases.py tests/test_module_backend_gates.py -v
npm run frontend:build
npx playwright test e2e/core_source_selection.spec.mjs --project=chromium
```

Expected: all commands PASS.

- [ ] **Step 5: Run repository verification appropriate to touched shared paths**

Run:

```bash
pytest -q
npm run e2e -- --project=chromium
git diff --check
git status --short
```

Expected: test suites PASS, no whitespace errors, and only expected tracked
feature changes remain before committing.

- [ ] **Step 6: Commit browser tests and final adjustments**

```bash
git add e2e/core_source_selection.spec.mjs playwright.config.mjs xkeen-ui tests
git commit -m "test: cover curated core source selection"
```

## Plan Self-Review

### Spec coverage

- Module-owned Xray/Mihomo UI and catalog: Tasks 1, 3, 4 and 5.
- Curated six-profile allowlist and stable-only policy: Task 1.
- Separate profile selection and installation: Tasks 2, 3, 4 and 5.
- Exact asset architecture resolver and mandatory checksum: Tasks 1 and 2.
- Backup, preflight, restart, health-check, locked transaction and rollback: Task 2.
- Separate selected/installed state, stale release cache and status rendering: Tasks 2, 3, 4 and 5.
- Legacy Commands compatibility without competing update actions: Task 4.
- API isolation, user input restrictions and module gates: Task 3.
- Unit, API, browser, responsive and full regression verification: Tasks 1-6.
- Explicit exclusion of arbitrary repositories: Global Constraints and Tasks 1, 3 and 5.

### Placeholder scan

No implementation step uses unresolved choices, generic error-handling language,
or a future-work placeholder. The future advanced mode remains explicitly out of
scope and is not a task in this plan.

### Type consistency

The catalog returns `CoreProfile` and JSON-safe release views to the installer.
The installer owns `plan_id`/`operation_id`; routes relay them unchanged; the
frontend sends only `profile_id` and `plan_id`. Xray and Mihomo adapters pass
the same `engine` values accepted by backend state, profile and installer APIs.
