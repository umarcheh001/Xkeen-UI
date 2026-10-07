# Stage 8.4 Lifecycle API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the existing trusted module transaction engine through a stable core-owned installed/available, plan/apply, status/cancel, recovery, and restart HTTP API.

**Architecture:** Add a Flask-independent `ModuleLifecycleService` that composes `ModuleRegistry`, the exact-release `ModuleCatalogClient`, and Stage 8.3 transaction primitives. Extend the existing modules blueprint with thin validated routes; all file mutation remains in the detached `module_transaction.py` runner.

**Tech Stack:** Python 3.11+, Flask, pytest, dataclasses/typing, SHA-256 canonical JSON, POSIX `/proc` process identity, existing Ed25519 catalog client and module transaction engine.

**Spec:** `docs/superpowers/specs/2026-10-06-modular-panel-stage8-4-lifecycle-api-design.md`

## Global Constraints

- Lifecycle operations are exactly `install`, `repair`, and `remove`; there is no separate `update` operation in Stage 8.4.
- Every package comes from the immutable signed catalog whose release version equals the installed panel release.
- Every catalog module reports `update_available: false` until Stage 8.5.
- Dependencies are never installed automatically and dependants are never removed automatically.
- `affected_module_ids` is always exactly `[module_id]`; module-only apply must not change a neighbouring module.
- Flask requests never download, unpack, replace, remove, or roll back module files; only the detached Stage 8.3 runner mutates the panel tree.
- Existing `/api/modules`, enable/disable, editor, and profile behavior remains backward compatible.
- Module API request bodies remain limited to 8 KiB JSON objects; successful responses use `Cache-Control: no-store`.
- Client input never supplies archive URLs, checksums, sizes, dependency lists, or file lists.
- API errors never expose tracebacks, secrets, archive temporary paths, transaction backup paths, or raw exception representations.
- New files must be committed before generated inventories are rebuilt. Rebuild Stage 0 inventory, synchronize module sizes, rebuild the inventory again to stability, then rebuild Stage 4.1, Stage 4.6, operator, icon, and Stage 8 snapshots.

## File Structure

| File | Responsibility |
| --- | --- |
| `xkeen-ui/services/module_lifecycle.py` | Flask-independent installed/available views, plan digest, apply/status, recovery, restart orchestration, and safe domain errors. |
| `xkeen-ui/services/module_transactions/launcher.py` | Runner identity validation, cancellation request, and restart-safety guards close to journal/process ownership. |
| `xkeen-ui/routes/modules.py` | Existing registry routes plus thin lifecycle HTTP validation and error mapping. |
| `xkeen-ui/routes/__init__.py` | Production construction and injection of `ModuleLifecycleService`. |
| `tests/support/module_lifecycle.py` | Complete catalog/service test fixtures and dependency recorders. |
| `tests/test_module_lifecycle.py` | Service contract tests using real registry, catalog data, and transaction plans where practical. |
| `tests/test_module_lifecycle_routes.py` | Flask route validation, status codes, headers, and legacy-route compatibility. |
| `tests/test_module_transactions_launcher.py` | Process identity, cancellation, and restart-guard unit tests. |
| `docs/modular-panel-stage8-lifecycle-api.md` | Endpoint/payload/error contract and manual recovery runbook. |
| `scripts/generate_modular_panel_stage8_contract.py` | Machine-readable Stage 8.4 lifecycle API section. |
| `tests/test_modular_panel_stage8_contract.py` | Generated lifecycle contract and closure assertions. |
| `README-modular-panel-plan.md`, `docs/modular-panel-stage8-official-module-manager.md`, `docs/README.md` | Mark 8.3/8.4 closed and identify 8.5 as next. |

---

### Task 1: Installed And Available Read Models

**Files:**
- Create: `xkeen-ui/services/module_lifecycle.py`
- Create: `tests/support/module_lifecycle.py`
- Create: `tests/test_module_lifecycle.py`

**Interfaces:**
- Consumes: `ModuleRegistry.get_registry()`, `read_panel_version(Path)`, `read_installed_modules(Path)`, and `ModuleCatalogClient.get_release_catalog(version)`.
- Produces: `ModuleLifecycleError`, `ModuleLifecycleService.__init__`, `ModuleLifecycleService.installed() -> dict[str, Any]`, and `ModuleLifecycleService.available() -> dict[str, Any]`.
- Constructor:

```python
ModuleLifecycleService(
    module_registry: ModuleRegistry,
    *,
    panel_root: Path,
    state_dir: Path,
    catalog_factory: Callable[[str, str], ModuleCatalogClient] | None = None,
    architecture_provider: Callable[[], str] = detect_platform_architecture,
    active_engines: Callable[[], frozenset[str]] | None = None,
    health_url: str = "",
    restart_cmd: Sequence[str] = (),
    restart_panel: Callable[[str], bool] | None = None,
    launch_operation: Callable[..., str] = launch,
    observe_operation: Callable[[Path, Path], dict[str, Any]] = observe_status,
    recover_operation: Callable[..., str | None] = recover,
    cancel_operation: Callable[..., None] | None = None,
) -> None
```

- `ModuleLifecycleError` stores `code: str`, `message: str`, `status: int`, and `details: dict[str, Any]`.

- [ ] **Step 1: Add complete test fixtures**

Create `tests/support/module_lifecycle.py` with a catalog recorder that returns the real `CatalogSnapshot` from `tests.support.module_tx.make_release()` and fails if latest-release discovery is called:

```python
class CatalogRecorder:
    def __init__(self, release, state_dir: Path):
        self.release = release
        self.client = release.client(state_dir)
        self.requested_versions: list[str] = []

    def get_release_catalog(self, version: str):
        self.requested_versions.append(version)
        return self.client.get_release_catalog(version)

    def get_catalog(self, **_kwargs):
        raise AssertionError("Stage 8.4 must not discover the latest release")


def make_service(panel, release, *, registry=None, **overrides):
    recorder = CatalogRecorder(release, panel.state)
    service = ModuleLifecycleService(
        registry or ModuleRegistry(str(panel.state), which=lambda _name: "/bin/tool"),
        panel_root=panel.root,
        state_dir=panel.state,
        catalog_factory=lambda _version, _architecture: recorder,
        architecture_provider=lambda: ARCHITECTURE,
        active_engines=lambda: frozenset(),
        health_url="http://127.0.0.1:8088/login",
        restart_cmd=("xkeen", "-restart"),
        restart_panel=lambda _source: True,
        **overrides,
    )
    return service, recorder
```

- [ ] **Step 2: Write failing installed/available tests**

Add these named behaviors to `tests/test_module_lifecycle.py`:

```python
def test_installed_uses_actual_install_manifest_without_fetching_catalog(tmp_path):
    panel = make_panel(tmp_path)
    service, catalog = make_service(panel, make_release())

    payload = service.installed()

    assert payload["ok"] is True
    assert payload["installed_module_ids"] == ["core", "engine.xray", "tool.editor"]
    assert {item["id"] for item in payload["modules"]} == {
        "core", "engine.xray", "tool.editor",
    }
    assert payload["lifecycle"]["available"] is True
    assert catalog.requested_versions == []


def test_available_uses_installed_release_and_exposes_only_stage83_actions(tmp_path):
    panel = make_panel(tmp_path)
    service, catalog = make_service(panel, make_release())

    payload = service.available()
    modules = {item["id"]: item for item in payload["modules"]}

    assert catalog.requested_versions == [VERSION]
    assert modules["core"]["lifecycle_actions"] == []
    assert modules["tool.editor"]["lifecycle_actions"] == ["repair"]
    assert modules["engine.xray"]["lifecycle_actions"] == ["repair", "remove"]
    assert modules["tool.terminal"]["lifecycle_actions"] == ["install"]
    assert all(item["update_available"] is False for item in modules.values())
```

Also add tests that a missing `module-installed.json` keeps the registry view readable but sets `lifecycle.available` false with `code == "module_state_unavailable"`, and that `available()` maps exact-release transport failure to `ModuleLifecycleError(code="catalog_unavailable", status=503)`.

- [ ] **Step 3: Run tests and verify RED**

Run:

```powershell
python -m pytest -q tests/test_module_lifecycle.py -k "installed or available"
```

Expected: collection fails because `services.module_lifecycle` does not exist.

- [ ] **Step 4: Implement the minimal read service**

In `module_lifecycle.py`:

```python
class ModuleLifecycleError(Exception):
    def __init__(self, code: str, message: str, *, status: int, **details: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.details = details


class ModuleLifecycleService:
    def _release_context(self):
        version = read_panel_version(self.panel_root)
        architecture = self._architecture_provider()
        client = self._catalog_factory(version, architecture)
        return version, architecture, client, client.get_release_catalog(version)

    def installed(self) -> dict[str, Any]:
        registry = self.module_registry.get_registry()
        try:
            installed_ids = read_installed_modules(self.state_dir)
            lifecycle = {"available": True, "code": None}
        except ModuleTransactionError as error:
            installed_ids = frozenset(
                item["id"] for item in registry["modules"] if item.get("installed") is True
            )
            lifecycle = {"available": False, "code": error.code}
        return {
            "ok": True,
            **{key: registry[key] for key in ("profile", "editor", "restart_required")},
            "installed_module_ids": [module_id for module_id in MODULE_IDS if module_id in installed_ids],
            "modules": [item for item in registry["modules"] if item["id"] in installed_ids],
            "lifecycle": lifecycle,
        }
```

Implement `available()` by indexing `snapshot.catalog["modules"]`, preserving catalog order, copying each complete normalized entry, and adding only `installed`, `lifecycle_actions`, and `update_available`. Do not call `get_catalog()`.

Map `CatalogClientError` and `ModuleTransactionError` through one private helper. Use status `503` for catalog transport/unavailable codes, `409` for release/state compatibility failures, and the error table from the spec for all later callers.

Keep `ModuleCatalogClient` under `TYPE_CHECKING` and import it inside the
default catalog factory. Importing `services.module_lifecycle` during app
startup must not load the Ed25519 dependency or perform catalog I/O.

- [ ] **Step 5: Run read-model and regression tests**

Run:

```powershell
python -m pytest -q tests/test_module_lifecycle.py -k "installed or available"
python -m pytest -q tests/test_module_catalog_client.py tests/test_module_registry.py
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit Task 1**

```powershell
git add xkeen-ui/services/module_lifecycle.py tests/support/module_lifecycle.py tests/test_module_lifecycle.py
git commit -m "feat(modules): expose installed and available lifecycle state"
```

---

### Task 2: Read-Only Plans, Dependency Diff, And Stale-Plan Digest

**Files:**
- Modify: `xkeen-ui/services/module_lifecycle.py`
- Modify: `tests/test_module_lifecycle.py`

**Interfaces:**
- Consumes: Task 1 `_release_context()`, Stage 8.3 `build_plan()` and `plan_to_json()`.
- Produces: `ModuleLifecycleService.plan(operation: str, module_id: str) -> dict[str, Any]` and private `_plan_and_payload(operation, module_id) -> tuple[Plan | None, dict[str, Any]]` used by Task 3.
- Applicable payloads contain a lowercase 64-character `plan_id`; blocked payloads contain `plan_id: None` and never write files.

- [ ] **Step 1: Write failing plan tests**

Add literal expectations:

```python
def test_plan_returns_single_module_file_and_dependency_diff(tmp_path):
    panel = make_panel(tmp_path)
    service, _ = make_service(panel, make_release())

    payload = service.plan("install", "tool.terminal")

    assert payload["applicable"] is True
    assert payload["affected_module_ids"] == ["tool.terminal"]
    assert payload["files_add"] == sorted(OWNERSHIP["tool.terminal"])
    assert payload["files_remove"] == []
    assert payload["dependency_diff"] == {
        "requires": ["core"], "missing": [], "conflicts": [], "required_by": [],
    }
    assert re.fullmatch(r"[0-9a-f]{64}", payload["plan_id"])


def test_missing_dependency_is_a_visible_blocker_not_an_automatic_install(tmp_path):
    panel = make_panel(tmp_path, installed=("core",))
    service, _ = make_service(panel, make_release())

    payload = service.plan("install", "engine.mihomo")

    assert payload["applicable"] is False
    assert payload["affected_module_ids"] == ["engine.mihomo"]
    assert payload["dependency_diff"]["missing"] == ["tool.editor"]
    assert [item["code"] for item in payload["blockers"]] == ["module_dependency_missing"]
    assert payload["plan_id"] is None
```

Add separate tests for installed conflicts, `required_by` on remove, active-engine removal, insufficient disk, installed/already-absent state, invalid operation, core, absent editor, and deterministic digest. The mutation check must prove that changing any of `files_add`, `installed_after`, `required_free_bytes`, or dependency diff changes the digest.

Assert unknown modules map to `ModuleLifecycleError(status=404,
code="module_not_found")`; unsupported operations and forbidden core/editor
operations map to status `400` with the existing transaction code.

- [ ] **Step 2: Run plan tests and verify RED**

Run:

```powershell
python -m pytest -q tests/test_module_lifecycle.py -k "plan or blocker or dependency or digest"
```

Expected: fails with missing `ModuleLifecycleService.plan`.

- [ ] **Step 3: Implement dependency diff and canonical digest**

Use the verified catalog entry and actual installed manifest:

```python
def _dependency_diff(catalog: Mapping[str, Any], module_id: str, installed: frozenset[str]) -> dict[str, list[str]]:
    entries = {str(item["id"]): item for item in catalog["modules"]}
    entry = entries[module_id]
    requires = sorted(set(entry["requires"]))
    return {
        "requires": requires,
        "missing": sorted(set(requires) - installed),
        "conflicts": sorted(set(entry["conflicts"]) & installed),
        "required_by": sorted(
            other for other in installed
            if other != module_id and module_id in entries.get(other, {}).get("requires", ())
        ),
    }


def _plan_digest(plan: Plan, dependency_diff: Mapping[str, Any]) -> str:
    canonical = json.dumps(
        {"plan": plan_to_json(plan), "dependency_diff": dependency_diff},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()
```

`_plan_and_payload` validates the operation and module id before catalog I/O. It calls `build_plan` with the exact-release catalog, current architecture, `active_engines()`, and default real free-space measurement. Convert these applicability errors to `200` blocker payloads: `module_already_installed`, `module_not_installed`, `module_dependency_missing`, `module_conflict`, `module_required_by`, `module_engine_active`, and `module_free_space`. Preserve error details in blocker fields, but do not expose paths beyond the public plan file lists.

Do not include the private archive/checksum structure in the public payload. It remains inside the digest and `Plan` handed to Task 3.

- [ ] **Step 4: Run plan and Stage 8.3 planner tests**

Run:

```powershell
python -m pytest -q tests/test_module_lifecycle.py -k "plan or blocker or dependency or digest"
python -m pytest -q tests/test_module_transactions_plan.py
```

Expected: all selected tests pass and the existing planner remains unchanged.

- [ ] **Step 5: Commit Task 2**

```powershell
git add xkeen-ui/services/module_lifecycle.py tests/test_module_lifecycle.py
git commit -m "feat(modules): add reviewed lifecycle plans"
```

---

### Task 3: Apply And Operation Status

**Files:**
- Modify: `xkeen-ui/services/module_lifecycle.py`
- Modify: `tests/support/module_lifecycle.py`
- Modify: `tests/test_module_lifecycle.py`

**Interfaces:**
- Consumes: Task 2 `_plan_and_payload`, injected `launch_operation`, injected `observe_operation`.
- Produces: `apply(operation: str, module_id: str, plan_id: str) -> dict[str, Any]` and `status() -> dict[str, Any]`.
- `apply` returns `{"ok": True, "operation_id": str, "status": dict}` after the detached runner has been launched; it never runs the operation inline.

- [ ] **Step 1: Add launch and status recorders to the support fixture**

```python
class LaunchRecorder:
    def __init__(self):
        self.plans: list[Plan] = []

    def __call__(self, plan: Plan, **_kwargs) -> str:
        self.plans.append(plan)
        return "20261006T120000Z-abcdef"


def status_record(**overrides):
    return {
        "operation_id": "20261006T120000Z-abcdef",
        "operation": "install",
        "module_id": "tool.terminal",
        "step": "prepared",
        "result": "running",
        "error_code": None,
        "error": None,
        "log": [],
        **overrides,
    }
```

- [ ] **Step 2: Write failing apply/status tests**

```python
def test_apply_rebuilds_and_launches_only_the_reviewed_server_plan(tmp_path):
    panel = make_panel(tmp_path)
    launcher = LaunchRecorder()
    service, _ = make_service(
        panel, make_release(), launch_operation=launcher,
        observe_operation=lambda _root, _state: status_record(),
    )
    preview = service.plan("install", "tool.terminal")

    payload = service.apply("install", "tool.terminal", preview["plan_id"])

    assert payload["operation_id"] == "20261006T120000Z-abcdef"
    assert len(launcher.plans) == 1
    assert launcher.plans[0].module_id == "tool.terminal"
    assert launcher.plans[0].files_add == tuple(sorted(OWNERSHIP["tool.terminal"]))


def test_apply_rejects_plan_when_installed_state_changed(tmp_path):
    panel = make_panel(tmp_path)
    launcher = LaunchRecorder()
    service, _ = make_service(panel, make_release(), launch_operation=launcher)
    preview = service.plan("install", "tool.terminal")
    installed = panel.read_json("module-installed.json")
    installed["modules"]["tool.terminal"] = True
    panel.path("module-installed.json").write_text(json.dumps(installed), encoding="utf-8")

    with pytest.raises(ModuleLifecycleError) as raised:
        service.apply("install", "tool.terminal", preview["plan_id"])

    assert (raised.value.code, raised.value.status) == ("module_plan_stale", 409)
    assert launcher.plans == []
```

Add tests for malformed digest, blocked rebuilt plan, launch `operation_in_progress`, required launch arguments (`panel_root`, `state_dir`, `health_url`, `restart_cmd`), and `status()` preserving ordered log/error/recovery fields from `observe_status`.

- [ ] **Step 3: Run apply/status tests and verify RED**

```powershell
python -m pytest -q tests/test_module_lifecycle.py -k "apply or status"
```

Expected: fails because `apply` and `status` are missing.

- [ ] **Step 4: Implement apply and status**

```python
def apply(self, operation: str, module_id: str, plan_id: str) -> dict[str, Any]:
    if not isinstance(plan_id, str) or re.fullmatch(r"[0-9a-f]{64}", plan_id) is None:
        raise ModuleLifecycleError("module_plan_id_invalid", "plan_id must be a lowercase SHA-256 digest", status=400)
    plan, payload = self._plan_and_payload(operation, module_id)
    if plan is None or not payload["applicable"]:
        raise ModuleLifecycleError("module_plan_stale", "the reviewed module plan is no longer applicable", status=409, blockers=payload["blockers"])
    if not hmac.compare_digest(payload["plan_id"], plan_id):
        raise ModuleLifecycleError("module_plan_stale", "the reviewed module plan is stale", status=409)
    operation_id = self._launch_operation(
        plan,
        panel_root=self.panel_root,
        state_dir=self.state_dir,
        health_url=self.health_url,
        restart_cmd=self.restart_cmd,
    )
    return {"ok": True, "operation_id": operation_id, "status": self._observe_operation(self.panel_root, self.state_dir)}
```

Catch and map Stage 8.3 errors without changing their stable `code`. `status()` returns `{"ok": True, **observed}`; if there is no status record, it returns `result: None` exactly as `read_status` does.

- [ ] **Step 5: Run service plus launcher/executor regressions**

```powershell
python -m pytest -q tests/test_module_lifecycle.py
python -m pytest -q tests/test_module_transactions_plan.py tests/test_module_transactions_executor.py tests/test_module_transactions_cli.py
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit Task 3**

```powershell
git add xkeen-ui/services/module_lifecycle.py tests/support/module_lifecycle.py tests/test_module_lifecycle.py
git commit -m "feat(modules): apply reviewed plans through detached runner"
```

---

### Task 4: Safe Cancel, Recovery, And Restart

**Files:**
- Modify: `xkeen-ui/services/module_transactions/launcher.py`
- Create: `tests/test_module_transactions_launcher.py`
- Modify: `xkeen-ui/services/module_lifecycle.py`
- Modify: `tests/test_module_lifecycle.py`

**Interfaces:**
- Produces in launcher: `request_cancel(panel_root: Path, state_dir: Path, operation_id: str, *, terminate: Callable[[int, int], None] = os.kill, read_cmdline: Callable[[int], tuple[str, ...]] = _read_proc_cmdline) -> None`.
- Produces in launcher: `ensure_restartable(panel_root: Path, state_dir: Path) -> None`.
- Produces in service: `cancel(operation_id)`, `recover()`, and `restart()` returning JSON-ready dictionaries.
- Extends the service constructor with `cancel_operation: Callable[..., None] = request_cancel` and `ensure_restartable_operation: Callable[[Path, Path], None] = ensure_restartable`; tests inject both boundaries.

- [ ] **Step 1: Write failing launcher cancellation tests**

Build a real `Journal` with a minimal real plan, call `journal.set_pid(os.getpid())`, and write a running status. Inject command-line and terminate recorders:

```python
def test_request_cancel_signals_only_matching_module_runner(tmp_path):
    panel = make_panel(tmp_path)
    plan = build_plan("install", "tool.terminal", **panel.kwargs)
    journal = Journal.create(panel.root, plan, "20261006T120000Z-abcdef", extra={})
    journal.set_pid(os.getpid())
    write_status(panel.state, {"operation_id": "20261006T120000Z-abcdef", "result": "running"})
    signals = []

    request_cancel(
        panel.root, panel.state, "20261006T120000Z-abcdef",
        read_cmdline=lambda _pid: (
            "python", "module_transaction.py", "run", "--operation", "20261006T120000Z-abcdef",
        ),
        terminate=lambda pid, sig: signals.append((pid, sig)),
    )

    assert signals == [(os.getpid(), signal.SIGTERM)]
```

Add separate tests that wrong operation id, terminal status, dead runner, missing journal, and cmdline without both `module_transaction.py run` and the exact operation id raise stable errors and never call `terminate`. Add a race test where `terminate` raises `ProcessLookupError`, expecting `operation_not_running`.

- [ ] **Step 2: Write failing restart-guard tests**

Cover these exact outcomes:

- live journal -> `operation_in_progress`;
- dead/uncommitted journal -> `operation_recovery_required`;
- status `rollback_failed` -> `operation_rollback_failed`;
- live panel-update lock -> `operation_in_progress`;
- no journal/update lock -> no error.

- [ ] **Step 3: Run launcher tests and verify RED**

```powershell
python -m pytest -q tests/test_module_transactions_launcher.py
```

Expected: import failure for `request_cancel` and `ensure_restartable`.

- [ ] **Step 4: Implement process identity and guards**

`_read_proc_cmdline(pid)` reads `/proc/<pid>/cmdline`, splits NUL bytes, and returns a tuple of decoded arguments. On Linux, unreadable or incomplete cmdline is a refusal, never permission to signal. On non-Linux, tests inject the reader and production falls back to journal PID/boot identity because `/proc` is unavailable.

The exact matcher is:

```python
def _is_expected_runner(argv: Sequence[str], operation_id: str) -> bool:
    names = [Path(part).name for part in argv]
    try:
        operation_index = argv.index("--operation")
    except ValueError:
        return False
    return (
        "module_transaction.py" in names
        and "run" in argv
        and operation_index + 1 < len(argv)
        and argv[operation_index + 1] == operation_id
    )
```

`ensure_restartable` first calls `ensure_idle` to honor the panel-update lock and rollback-failed guard, then refuses any remaining journal directory as `operation_recovery_required`.

- [ ] **Step 5: Write failing service control tests**

Add tests asserting:

```python
def test_recovery_never_restarts_implicitly(tmp_path):
    panel = make_panel(tmp_path)
    restarts = []
    service, _ = make_service(
        panel, make_release(),
        recover_operation=lambda _root, _state, *, panel_running: "rolled_back",
        observe_operation=lambda _root, _state: status_record(
            result="rolled_back", restart_required=True
        ),
        restart_panel=lambda source: restarts.append(source) or True,
    )

    payload = service.recover()

    assert payload["result"] == "rolled_back"
    assert payload["restart_required"] is True
    assert restarts == []
```

Also test: cancel delegates the exact id; recovery maps live-runner refusal to 409; restart calls source `module-lifecycle` only after `ensure_restartable`; false/exceptional restart maps to `module_restart_failed` status 503; successful restart returns `restart_requested: true`.

- [ ] **Step 6: Implement service control methods and run GREEN**

Use injected callables and map only domain errors:

```python
def recover(self) -> dict[str, Any]:
    result = self._recover_operation(self.panel_root, self.state_dir, panel_running=True)
    return {"ok": True, "recovery_result": result, **self._observe_operation(self.panel_root, self.state_dir)}


def restart(self) -> dict[str, Any]:
    self._ensure_restartable(self.panel_root, self.state_dir)
    if self._restart_panel is None or not self._restart_panel("module-lifecycle"):
        raise ModuleLifecycleError("module_restart_failed", "the panel restart could not be dispatched", status=503)
    return {"ok": True, "restart_requested": True}
```

Run:

```powershell
python -m pytest -q tests/test_module_transactions_launcher.py tests/test_module_lifecycle.py
python -m pytest -q tests/test_module_transactions_executor.py tests/test_module_transactions_journal.py tests/test_module_transactions_cli.py
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit Task 4**

```powershell
git add xkeen-ui/services/module_transactions/launcher.py xkeen-ui/services/module_lifecycle.py tests/test_module_transactions_launcher.py tests/test_module_lifecycle.py
git commit -m "feat(modules): add safe lifecycle control and recovery"
```

---

### Task 5: HTTP Routes And Production Wiring

**Files:**
- Modify: `xkeen-ui/routes/modules.py`
- Modify: `xkeen-ui/routes/__init__.py`
- Create: `tests/test_module_lifecycle_routes.py`
- Modify: `tests/test_module_registry.py`
- Modify: `tests/test_module_backend_gates.py`

**Interfaces:**
- Changes `create_modules_blueprint(module_registry, *, before_change=None, lifecycle_service: ModuleLifecycleService | None = None)`.
- Adds the eight endpoints from the spec without changing existing endpoint payloads.
- Production health URL is `http://127.0.0.1:<XKEEN_UI_PORT>/login`, where the port defaults to `8088` and invalid/out-of-range values also fall back to `8088`.

- [ ] **Step 1: Create a complete route fake and failing route tests**

The fake records method arguments and returns literal payloads. Register the blueprint in a testing Flask app. Add tests for every endpoint and exact status:

```python
def test_lifecycle_plan_and_apply_routes_validate_and_delegate(app_with_lifecycle):
    client, service = app_with_lifecycle

    plan = client.post("/api/modules/operations/plan", json={
        "operation": "install", "module_id": "tool.terminal",
    })
    applied = client.post("/api/modules/operations/apply", json={
        "operation": "install", "module_id": "tool.terminal", "plan_id": "a" * 64,
    })

    assert plan.status_code == 200
    assert applied.status_code == 202
    assert service.calls == [
        ("plan", "install", "tool.terminal"),
        ("apply", "install", "tool.terminal", "a" * 64),
    ]
    assert plan.headers["Cache-Control"] == "no-store"
    assert applied.headers["Cache-Control"] == "no-store"
```

Add cases for installed, available, status, operation-id cancel, recovery, and restart. Add validation cases for non-object JSON, unsupported fields, missing fields, body larger than 8192 bytes, malformed plan id, and a cancel URL with an unknown id. Assert `ModuleLifecycleError` maps to its status/code/details and an unexpected exception maps to `module_lifecycle_failed` without including the exception text.

- [ ] **Step 2: Run route tests and verify RED**

```powershell
python -m pytest -q tests/test_module_lifecycle_routes.py
```

Expected: new endpoints return 404.

- [ ] **Step 3: Implement thin lifecycle handlers**

Factor the existing payload-size and JSON-object checks into local helpers used by both old and new handlers without changing old error codes. Add:

```python
@bp.get("/api/modules/installed")
@bp.get("/api/modules/available")
@bp.post("/api/modules/operations/plan")
@bp.post("/api/modules/operations/apply")
@bp.get("/api/modules/operations/status")
@bp.post("/api/modules/operations/<operation_id>/cancel")
@bp.post("/api/modules/recovery")
@bp.post("/api/modules/restart")
```

If `lifecycle_service` is absent, only these new endpoints return `503` with `code: module_lifecycle_unavailable`; all legacy endpoints continue to work in unit tests and older composition sites.

- [ ] **Step 4: Wire production service lazily and safely**

In `routes/__init__.py`, construct the service before registering the modules blueprint. Do not read `BUILD.json`, import cryptography, fetch the catalog, detect architecture, or inspect `/proc` during app startup. Pass factories/providers so those actions occur only when a lifecycle endpoint needs them.

Use:

```python
port_text = str(os.environ.get("XKEEN_UI_PORT") or "8088").strip()
try:
    module_health_port = int(port_text)
except ValueError:
    module_health_port = 8088
if not 1 <= module_health_port <= 65535:
    module_health_port = 8088

lifecycle_service = ModuleLifecycleService(
    ctx.module_registry,
    panel_root=Path(ctx.ui_state_dir),
    state_dir=Path(ctx.ui_state_dir),
    active_engines=lambda: frozenset({
        {"xray": "engine.xray", "mihomo": "engine.mihomo"}.get(detect_running_core(), "")
    }) - {""},
    health_url=f"http://127.0.0.1:{module_health_port}/login",
    restart_cmd=tuple(build_xkeen_cmd("-restart")),
    restart_panel=lambda source: bool(ctx.restart_xkeen(source=source)),
)
```

Keep optional imports inside the service/factory or the route composition function so a missing optional dependency cannot prevent core blueprint registration.

- [ ] **Step 5: Add composition and legacy regression assertions**

Extend `test_module_backend_gates.py` to assert the core `modules` blueprint remains registered for every module profile. Extend `test_module_registry.py` with one test that registers the blueprint without a lifecycle service, confirms `GET /api/modules` is still `200`, and confirms only `GET /api/modules/installed` returns the documented `503`.

- [ ] **Step 6: Run route, registry, and composition tests**

```powershell
python -m pytest -q tests/test_module_lifecycle_routes.py tests/test_module_registry.py tests/test_module_backend_gates.py
python -m pytest -q tests/test_module_lifecycle.py tests/test_module_transactions_launcher.py
```

Expected: all selected tests pass with no warnings introduced by lifecycle code.

- [ ] **Step 7: Commit Task 5**

```powershell
git add xkeen-ui/routes/modules.py xkeen-ui/routes/__init__.py tests/test_module_lifecycle_routes.py tests/test_module_registry.py tests/test_module_backend_gates.py
git commit -m "feat(modules): expose lifecycle HTTP API"
```

---

### Task 6: Generated Contract, Documentation, Closure, And Full Verification

**Files:**
- Create: `docs/modular-panel-stage8-lifecycle-api.md`
- Modify: `scripts/generate_modular_panel_stage8_contract.py`
- Modify: `tests/test_modular_panel_stage8_contract.py`
- Modify: `docs/modular-panel-stage8-contract.json`
- Modify: `docs/modular-panel-stage8-contract.md`
- Modify: `README-modular-panel-plan.md`
- Modify: `docs/modular-panel-stage8-official-module-manager.md`
- Modify: `docs/README.md`
- Regenerate: `docs/modular-panel-stage0-inventory.json`
- Regenerate: `docs/modular-panel-stage0-inventory.md`
- Regenerate: `xkeen-ui/module-sizes.json`
- Regenerate other repository contract/inventory snapshots changed by the standard generator sequence.

**Interfaces:**
- Stage 8 generated contract adds `lifecycle_api` with exact routes, operations, plan/apply boundary, cancellation identity rule, and recovery/restart separation.
- Human docs declare 8.3 and 8.4 closed only after all verification commands in this task pass.

- [ ] **Step 1: Write failing generated-contract assertions**

Add literal assertions to `test_modular_panel_stage8_contract.py`:

```python
lifecycle = contract["lifecycle_api"]
assert lifecycle["operations"] == ["install", "repair", "remove"]
assert lifecycle["update_available"] is False
assert lifecycle["catalog"] == "installed panel release only"
assert lifecycle["apply"] == "rebuild server plan and compare SHA-256 plan_id"
assert lifecycle["affected_modules"] == "selected module only"
assert lifecycle["cancel_identity"] == "/proc/<pid>/cmdline + operation id"
assert lifecycle["recovery_restart"] == "explicit separate action"
assert lifecycle["routes"] == [
    "GET /api/modules/installed",
    "GET /api/modules/available",
    "POST /api/modules/operations/plan",
    "POST /api/modules/operations/apply",
    "GET /api/modules/operations/status",
    "POST /api/modules/operations/<operation_id>/cancel",
    "POST /api/modules/recovery",
    "POST /api/modules/restart",
]
```

Assert the roadmap says 8.4 is closed, 8.5 is next, and links both the design and implementation plan.

- [ ] **Step 2: Run contract test and verify RED**

```powershell
python -m pytest -q tests/test_modular_panel_stage8_contract.py
```

Expected: fails because `lifecycle_api` and closure text are absent.

- [ ] **Step 3: Extend the generator and rebuild Stage 8 contract**

Add the exact `lifecycle_api` object asserted above to `generate_modular_panel_stage8_contract.py`, then run:

```powershell
python scripts/generate_modular_panel_stage8_contract.py --root .
python -m pytest -q tests/test_modular_panel_stage8_contract.py
```

Expected: generated JSON/Markdown match the generator; closure assertions remain failing until Step 4.

- [ ] **Step 4: Write endpoint contract and recovery runbook**

Create `docs/modular-panel-stage8-lifecycle-api.md` with:

- all eight endpoint request/response examples using the exact field names from Tasks 1-5;
- the HTTP/error-code table from the spec;
- explanation that `plan_id` is a stale-plan digest, not authorization;
- `update_available: false` and the no-update rationale;
- manual recovery sequence: read status, attempt cancel, poll until terminal, call recovery only when the runner is dead, inspect `rollback_failed`, call restart only when `restart_required` is true;
- router checks for install, cancel-before-apply, cancel-after-apply rollback, killed runner recovery, and restart refusal during a live operation.

Update the roadmap, overview, and docs index. State that 8.3 and 8.4 are closed on 2026-10-06 and 8.5 is next. Do not claim that panel update, profile transition, UI, or notifications are implemented.

- [ ] **Step 5: Run targeted Stage 8.4 verification before snapshots**

```powershell
python -m pytest -q tests/test_module_lifecycle.py tests/test_module_lifecycle_routes.py tests/test_module_transactions_launcher.py
python -m pytest -q tests/test_module_transactions_plan.py tests/test_module_transactions_executor.py tests/test_module_transactions_journal.py tests/test_module_transactions_cli.py
python -m pytest -q tests/test_module_catalog_client.py tests/test_module_registry.py tests/test_module_backend_gates.py tests/test_modular_panel_stage8_contract.py
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit implementation docs and Stage 8 contract**

```powershell
git add docs/modular-panel-stage8-lifecycle-api.md scripts/generate_modular_panel_stage8_contract.py tests/test_modular_panel_stage8_contract.py docs/modular-panel-stage8-contract.json docs/modular-panel-stage8-contract.md README-modular-panel-plan.md docs/modular-panel-stage8-official-module-manager.md docs/README.md
git commit -m "docs(modules): close stage 8.4 lifecycle API"
```

- [ ] **Step 7: Rebuild repository inventories in the established order**

```powershell
python scripts/generate_modular_panel_inventory.py --root .
python scripts/sync_module_sizes.py --root .
python scripts/generate_modular_panel_inventory.py --root .
python scripts/generate_modular_panel_stage4_1_contract.py --root .
python scripts/generate_modular_panel_stage4_6_compatibility.py --root .
python scripts/generate_panel_operator_inventory.py --root .
python scripts/generate_operator_icon_inventory.py
python scripts/generate_modular_panel_stage8_contract.py --root .
```

Repeat `generate_modular_panel_inventory.py` and `sync_module_sizes.py` until a subsequent run produces no diff. Do not hand-edit generated files.

- [ ] **Step 8: Verify generated snapshots and commit them separately**

```powershell
python -m pytest -q tests/test_modular_panel_stage0_inventory.py tests/test_modular_panel_stage4_1_contract.py tests/test_modular_panel_stage4_6_compatibility.py tests/test_modular_panel_stage8_contract.py tests/test_panel_operator_stage0_contract.py tests/test_operator_icons.py
git diff --check
git add docs/modular-panel-stage0-inventory.json docs/modular-panel-stage0-inventory.md xkeen-ui/module-sizes.json docs/modular-panel-stage4.1-contract.json docs/modular-panel-stage4.1-contract.md docs/modular-panel-stage4.6-compatibility.json docs/panel-operator-stage0-inventory.json docs/panel-operator-icon-inventory.json docs/modular-panel-stage8-contract.json docs/modular-panel-stage8-contract.md
git commit -m "chore(modules): rebuild inventories after lifecycle API"
```

If a listed generated file has no diff, `git add` simply leaves it out of the commit.

- [ ] **Step 9: Run fresh full verification**

```powershell
python -m compileall -q xkeen-ui/services/module_lifecycle.py xkeen-ui/services/module_transactions/launcher.py xkeen-ui/routes/modules.py xkeen-ui/routes/__init__.py
python -m pytest -q
git diff --check
git status --short --branch
```

Expected: compileall exits 0; pytest reports zero failures; diff check exits 0; worktree contains no uncommitted files and the branch is ahead only by the planned commits.

- [ ] **Step 10: Review requirements against the spec**

Read `docs/superpowers/specs/2026-10-06-modular-panel-stage8-4-lifecycle-api-design.md` line by line. Confirm every goal, non-goal, endpoint, dependency/isolation rule, error class, test group, and documentation/closure requirement is represented in the implementation and fresh verification evidence. Record any deviation before claiming Stage 8.4 complete.
