# Stage 8.3 Transaction/Updater Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Установка, починка и удаление одного официального модуля панели из проверенного архива — с журналом, откатом и восстановлением после обрыва.

**Architecture:** Файлы модуля кладутся в общий корень панели под журналом с копией заменяемых файлов. Операцию ведёт отдельный процесс `scripts/module_transaction.py`; он перезапускает панель, ждёт её ответа и подтверждает либо откатывает. Init-скрипт при загрузке доигрывает прерванную операцию. Состав модулей, внешние зависимости по импортам и полные manifest сборки приезжают в `module-ownership.json`.

**Tech Stack:** Python 3.11 stdlib (`tarfile`, `shutil`, `subprocess`, `urllib`), существующие `services.module_package_contract`, `services.module_catalog_client`, `services.self_update.state`; POSIX sh в `install.sh`; pytest.

**Spec:** `docs/superpowers/specs/2026-10-05-modular-panel-stage8-3-transaction-engine-design.md`

## Global Constraints

- Ветка `codex/modular-panel-testing`; в `main` ничего не вносить, rebase не делать, не пушить без команды пользователя.
- Коммит: `git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit`; сообщение на русском простым языком, без трейлеров.
- Перед каждым коммитом `git fetch origin` и сверка, не пришли ли чужие коммиты.
- Новые файлы сначала `git add`, затем слепки: `python scripts/generate_modular_panel_inventory.py` → `python scripts/sync_module_sizes.py` → снова генератор до устойчивости → `generate_modular_panel_stage4_1_contract.py` → 4.6 compatibility → `generate_panel_operator_inventory.py` → `generate_operator_icon_inventory.py`. Слепки — отдельным коммитом «Опись панели пересобрана после …».
- Полный pytest запускать из Bash, не из PowerShell. После него `git checkout -- docs/modular-panel-stage5-frontend-loading.md`.
- Регулярные выражения и тесты с обратными слэшами писать файлом (Write), не heredoc. JS и `.gitignore` — с сохранением CRLF.
- Код движка (`services/module_transactions/*`, `scripts/module_transaction.py`) не импортирует `flask`, `app_factory`, `routes`.
- Все новые файлы движка принадлежат пакету `core` и по `owner()` установщика, и по `build_module_ownership`.
- Версия модуля обязана равняться версии панели из `BUILD.json`; версия не по semver → `panel_version_unsupported`.
- Каталог операций: `<panel_root>.module-transactions/<operation-id>/`; состояние: `<state_dir>/module-operations/status.json`.
- Таймаут проверки запуска 120 с, переопределение `XKEEN_UI_MODULE_TX_HEALTH_TIMEOUT`.
- Строки `install.sh`, которые тесты автора проверяют дословно (установка `cryptography`), не менять.
- В UI и сообщениях не называть Happ: «Утилита ссылок подписок».

## Review Focus

1. **`recover` во время идущей операции.** Исполнитель перезапускает панель через init-скрипт, тот зовёт `recover`; операция не должна откатиться сама себя. Тест — Task 8.
2. **Место кончилось посреди раскладки (`ENOSPC`).** Ожидание: откат, дерево байт в байт прежнее. Тест — Task 6.
3. **Повреждённый `operation.json` или `actions.log`.** Ожидание: `recover` не падает и не мешает загрузке; при наличии `backup/` возвращает файлы, иначе удаляет каталог. Тест — Task 8.
4. **Обрыв сети посреди скачивания.** Ожидание: корень не тронут, итог `interrupted` либо ошибка транспорта, каталог операции убран. Тест — Task 7.
5. **`.gz` старше исходника после раскладки.** Ожидание: панель отдаёт сжатую копию установленного модуля. Тест — Task 6.

---

## File Structure

| Файл | Ответственность |
| --- | --- |
| `scripts/build_modular_panel_release.py` (modify) | Владение `.gz`, карта владения. |
| `scripts/build_user_archive.py` (modify) | Запись карты в локальный архив. |
| `.github/workflows/build-user-archive.yml` (modify) | Карта в bootstrap archive, пакеты из `package-root`. |
| `xkeen-ui/services/module_catalog_client.py` (modify) | `get_release_catalog`. |
| `xkeen-ui/services/module_transactions/__init__.py` (create) | Пустой пакет. |
| `xkeen-ui/services/module_transactions/state.py` (create) | Ошибка, пути, `status.json`, id операции. |
| `xkeen-ui/services/module_transactions/plan.py` (create) | Карта владения, версия панели, `build_plan`. |
| `xkeen-ui/services/module_transactions/extract.py` (create) | Безопасная распаковка payload. |
| `xkeen-ui/services/module_transactions/journal.py` (create) | Каталог операции, раскладка, откат. |
| `xkeen-ui/services/module_transactions/install_state.py` (create) | State-файлы и manifest сборки после операции. |
| `xkeen-ui/services/module_transactions/executor.py` (create) | Ход операции, проверка запуска, `recover`. |
| `xkeen-ui/services/module_transactions/launcher.py` (create) | Запуск исполнителя оторванным процессом. |
| `xkeen-ui/scripts/module_transaction.py` (create) | CLI `run` / `recover` / `status`. |
| `xkeen-ui/install.sh` (modify) | `recover` в init-скрипте и перед профилем, уборка после успеха. |
| `xkeen-ui/static/js/pages/{backups,mihomo_generator}.screen.bootstrap.js` (modify) | Monaco по требованию. |
| `scripts/generate_modular_panel_stage8_contract.py`, `docs/…stage8…`, `README-modular-panel-plan.md` (modify) | Правка контракта. |

---

### Task 1: Карта владения в сборщике

**Files:**
- Modify: `scripts/build_modular_panel_release.py` (`build_module_ownership`, `_KNOWN_PACKAGE_FILES`, `parse_args`/`main`)
- Test: `tests/test_modular_panel_ownership_map.py`

**Interfaces:**
- Produces:
  - `build_module_ownership(root)` — как раньше, но `<имя>.gz` рядом с существующим `<имя>` получает владельца исходника после замыкания по импортам;
  - `build_ownership_map(root: Path) -> dict` с ключами `schema_version` (1), `modules` (`{module_id: [paths]}`), `frontend` (`{"bridge": dict, "build": dict}`; пустые словари, если manifest нет);
  - `write_ownership_map(root: Path) -> Path` — пишет `<root>/xkeen-ui/module-ownership.json` (UTF-8, LF, `sort_keys`, отступ 2);
  - CLI: `--write-ownership-map` — только записать карту и выйти.
  - `module-ownership.json` добавлен в `_KNOWN_PACKAGE_FILES` (владелец `core`) и присутствует в собственном списке `modules["core"]`.

- [ ] **Step 1: Failing tests**

```python
def test_gz_follows_its_source_owner(release_tree):          # дерево-фикстура из test_modular_panel_release_builder.py
    (release_tree / "xkeen-ui/static/js/pages/terminal.lazy.entry.js.gz").write_bytes(b"gz")
    ownership = builder.build_module_ownership(release_tree)
    assert "static/js/pages/terminal.lazy.entry.js.gz" in ownership["tool.terminal"]

def test_map_contains_itself_and_full_frontend_manifests(release_tree):
    path = builder.write_ownership_map(release_tree)
    data = json.loads(path.read_text(encoding="utf-8"))
    assert "module-ownership.json" in data["modules"]["core"]
    assert set(data["frontend"]) == {"bridge", "build"}

def test_map_is_deterministic(release_tree):
    assert builder.write_ownership_map(release_tree).read_bytes() == builder.write_ownership_map(release_tree).read_bytes()
```

- [ ] **Step 2:** `python -m pytest tests/test_modular_panel_ownership_map.py -q` → FAIL (`build_ownership_map` нет).
- [ ] **Step 3: Implement.** `.gz`: в основном цикле `build_module_ownership` пропускать `relative.endswith(".gz")`, если `relative[:-3]` — файл пакета; после замыкания присвоить владельца исходника. Запись карты в `write_ownership_map` выполняется до расчёта, чтобы файл попал в собственный список (сначала создать пустой файл, посчитать, записать).
- [ ] **Step 4:** тесты Task 1 и `tests/test_modular_panel_release_builder.py tests/test_modular_panel_stage8_contract.py` → PASS.
- [ ] **Step 5: Замер на настоящем дереве** (нужен `npm run frontend:build`): `python scripts/build_modular_panel_release.py --root . --write-ownership-map`, проверить, что в `modules` девять модулей, каждый файл ровно в одном, а оба manifest сборки лежат целиком; затем удалить `xkeen-ui/module-ownership.json` из рабочего дерева (в репозиторий он не попадает, `.gitignore` не трогать) и убедиться, что `git status` чист.
- [ ] **Step 6: Commit** — «Сборщик записывает, какие файлы принадлежат каждому модулю панели».

### Task 2: Карта в архивах и пакеты из `package-root`

**Files:**
- Modify: `.github/workflows/build-user-archive.yml`, `scripts/build_user_archive.py`
- Test: `tests/test_modular_panel_release_workflow.py`, `tests/test_build_user_archive_ownership_map.py`

**Interfaces:**
- Consumes: `write_ownership_map(root)` из Task 1.
- Produces: в `package-root/xkeen-ui/` и в локальном архиве лежит `module-ownership.json`; шаг «Build modular panel release assets» вызывается с `--root package-root`.

- [ ] **Step 1: Failing tests.** В workflow-тесте: шаг записи карты (`--write-ownership-map --root package-root`) стоит после сжатия статики и до «Create user archive»; сборка пакетов использует `--root package-root`. Для локального архива: после `build_user_archive` во временное дерево файл карты существует и разбирается как JSON с ключом `modules`.
- [ ] **Step 2:** запуск → FAIL.
- [ ] **Step 3: Implement.** В workflow шаг записи карты поставить сразу после `precompress_static_assets` и до `write_build_json` (отпечаток `tree_sha256` должен включать карту). В `build_user_archive.py` — тот же вызов в том же месте; сбой расчёта карты в локальной сборке — предупреждение, не ошибка.
- [ ] **Step 4:** тесты → PASS; локально `python scripts/build_modular_panel_release.py --root <копия package-root> …` собирает пакеты, у каждого `.gz` из пакета исходник в том же пакете.
- [ ] **Step 5: Commit** — «Архив панели и пакеты модулей собираются из одного дерева со сжатой статикой».

### Task 3: Каталог конкретного релиза

**Files:**
- Modify: `xkeen-ui/services/module_catalog_client.py`
- Test: `tests/test_module_catalog_client.py`

**Interfaces:**
- Produces: `ModuleCatalogClient.get_release_catalog(self, release_version: str) -> CatalogSnapshot`. Кэш `<ui_state_dir>/module-catalog/catalog-<version>.json` того же формата, что `catalog-cache.json`; кэш перепроверяется `_verified_snapshot` при чтении; `freshness="fresh"` всегда; порог отката не применяется; повреждённый кэш — перекачать, а не ошибка.

- [ ] **Step 1: Failing tests** (помощники подписи и поддельный transport — из этого же файла):

```python
def test_release_catalog_is_fetched_by_exact_tag_and_cached(...):
    snapshot = client.get_release_catalog("2.10.0")
    assert snapshot.release_version == "2.10.0"
    assert transport.requested == [catalog_url("2.10.0"), signature_url("2.10.0")]
    client.get_release_catalog("2.10.0"); assert len(transport.requested) == 2

def test_release_catalog_older_than_latest_cache_is_accepted(...)       # нет catalog_version_rollback
def test_release_catalog_rejects_document_of_another_version(...)        # catalog_release_version_mismatch
def test_release_catalog_refetches_when_cache_file_is_corrupt(...)
def test_release_catalog_rejects_non_semver_version(...)                 # catalog_release_version_invalid
```

- [ ] **Step 2–4:** FAIL → реализация → PASS вместе со всем файлом.
- [ ] **Step 5: Commit** — «Панель умеет брать каталог модулей своей версии, а не только последней».

### Task 4: Состояние операции

**Files:**
- Create: `xkeen-ui/services/module_transactions/__init__.py`, `state.py`
- Test: `tests/test_module_transactions_state.py`

**Interfaces:**
- Produces:
  - `class ModuleTransactionError(Exception)` с `code: str`, `message: str`, `details: dict`;
  - `STEPS = ("prepared","downloading","verifying","applying","state","restarting","health","committed","rolling_back")`;
  - `RESULTS = ("running","committed","rolled_back","interrupted","rollback_failed")`;
  - `transactions_root(panel_root: Path) -> Path` → `panel_root.parent / (panel_root.name + ".module-transactions")`;
  - `status_path(state_dir: Path) -> Path` → `state_dir / "module-operations" / "status.json"`;
  - `read_status(state_dir) -> dict` (никогда не бросает; при отсутствии — `{"result": None}`);
  - `write_status(state_dir, status: Mapping) -> None` (атомарно, уникальное временное имя);
  - `new_operation_id(now: float | None = None) -> str` формата `YYYYMMDDTHHMMSSZ-xxxxxx`;
  - `pid_alive(pid: object) -> bool`.

- [ ] **Step 1: Failing tests:** формат id (`re.fullmatch(r"\d{8}T\d{6}Z-[0-9a-f]{6}", …)`), `read_status` на отсутствующем и битом файле, круговая запись/чтение, `transactions_root(Path("/opt/etc/xkeen-ui")) == Path("/opt/etc/xkeen-ui.module-transactions")`, `pid_alive(os.getpid())` и `pid_alive("x") is False`.
- [ ] **Step 2–4:** FAIL → реализация (атомарная запись через существующий `services.io` или `_atomic_write_json`, как в клиенте каталога) → PASS.
- [ ] **Step 5: Commit** вместе с Task 5.

### Task 5: Планировщик

**Files:**
- Create: `xkeen-ui/services/module_transactions/plan.py`
- Test: `tests/test_module_transactions_plan.py`

**Interfaces:**
- Consumes: `ModuleTransactionError`; снимок каталога (`CatalogSnapshot.catalog`, уже проверенный); `validate_semver`.
- Produces:

```python
@dataclass(frozen=True, slots=True)
class OwnershipMap:
    modules: Mapping[str, tuple[str, ...]]
    frontend: Mapping[str, Mapping[str, Any]]

@dataclass(frozen=True, slots=True)
class ArchiveSource:
    archive: str; size: int; sha256: str

@dataclass(frozen=True, slots=True)
class Plan:
    operation: str            # "install" | "repair" | "remove"
    module_id: str
    version: str
    files_add: tuple[str, ...]
    files_remove: tuple[str, ...]
    archive: ArchiveSource | None      # None для remove
    required_free_bytes: int
    restart_required: bool
    installed_after: tuple[str, ...]   # полный список установленных модулей после операции

def load_ownership_map(panel_root: Path) -> OwnershipMap          # module_ownership_unavailable
def read_panel_version(panel_root: Path) -> str                   # panel_version_unsupported
def read_installed_modules(state_dir: Path) -> frozenset[str]     # module-installed.json, значения True
def build_plan(operation: str, module_id: str, *, panel_root: Path, state_dir: Path,
               catalog: Mapping[str, Any], architecture: str,
               active_engines: frozenset[str] = frozenset(),
               free_bytes: int | None = None) -> Plan
def plan_to_json(plan: Plan) -> dict
def plan_from_json(data: Mapping[str, Any]) -> Plan
```

Правила `build_plan` (каждое — отдельный тест с кодом ошибки):

| Условие | Код |
| --- | --- |
| неизвестная операция, `core`, либо `tool.editor` не для `repair` | `module_operation_forbidden` |
| `catalog["release_version"]` ≠ версия панели или версия записи модуля ≠ версия панели | `module_version_mismatch` |
| `architecture` нет в `architectures` записи | `catalog_architecture_unsupported` |
| `install` установленного | `module_already_installed` |
| `repair`/`remove` неустановленного | `module_not_installed` |
| `install`: запись `requires` не установлена | `module_dependency_missing` |
| `install`: установлен модуль из `conflicts` | `module_conflict` |
| `remove`: модуль есть в `requires` установленного | `module_required_by` |
| `remove`: модуль в `active_engines` | `module_engine_active` |
| путь из `modules[module_id]` принадлежит пользователю (`_user_owned`-правила) | `module_ownership_conflict` |
| `free_bytes < required_free_bytes` | `module_free_space` |

`files_add` для `install`/`repair` = `modules[module_id]`. `archive` — запись модуля из каталога. `files_remove` для `remove` = `modules[module_id]`, существующие на диске. `required_free_bytes` = `size` архива + `max_size` записи (если нет — `4 × size`) + Σ размеров заменяемых и удаляемых файлов, всё × 1.2. `free_bytes=None` → `shutil.disk_usage(transactions_root(panel_root).parent).free`. Правила пользовательских путей — скопировать константы из `module_profile_install.py` (тест сверяет их с оригиналом, чтобы не разошлись).

- [ ] **Step 1: Failing tests** — по одному на строку таблицы, плюс:

```python
def test_install_plan_lists_exactly_the_module_files(panel):
    plan = build_plan("install", "tool.backups", **panel.kwargs)
    assert plan.files_add == panel.map.modules["tool.backups"] and plan.files_remove == ()

def test_remove_plan_lists_only_files_present_on_disk(panel): ...
def test_plan_json_round_trip(panel): assert plan_from_json(plan_to_json(plan)) == plan
def test_build_plan_writes_nothing(panel): ...                          # снимок дерева до и после равен
def test_user_owned_rules_match_installer(): ...
```

- [ ] **Step 2–4:** FAIL → реализация → PASS.
- [ ] **Step 5: Commit** (Task 4 + 5) — «Панель заранее проверяет, можно ли установить или удалить модуль».

### Task 6: Журнал и раскладка файлов

**Files:**
- Create: `xkeen-ui/services/module_transactions/journal.py`, `extract.py`
- Test: `tests/test_module_transactions_journal.py`, `tests/test_module_transactions_extract.py`

**Interfaces:**
- Consumes: `Plan`, `plan_to_json`, `transactions_root`, `ModuleTransactionError`.
- Produces:

```python
def extract_payload(archive: Path, destination: Path, only: Collection[str]) -> tuple[str, ...]
# Только regular files из payload/, путь перепроверяется, результат — извлечённые относительные пути.
# Файл из `only`, которого нет в архиве → ModuleTransactionError("archive_member_missing").

class Journal:
    dir: Path; staging: Path; backup: Path; plan: Plan; panel_root: Path
    @classmethod
    def create(cls, panel_root: Path, plan: Plan, operation_id: str, *, extra: Mapping[str, Any]) -> "Journal"
    @classmethod
    def open(cls, operation_dir: Path) -> "Journal"          # битый operation.json → ModuleTransactionError("operation_journal_invalid")
    @staticmethod
    def find(panel_root: Path) -> Path | None                # единственный каталог операции либо None
    def meta(self) -> dict                                   # operation.json: plan, step, pid, health_url, restart_cmd, started_at
    def set_step(self, step: str) -> None
    def set_pid(self, pid: int) -> None
    def apply_file(self, relative: str, source: Path) -> None
    def remove_file(self, relative: str) -> None
    def write_state_file(self, relative: str, payload: bytes) -> None
    def align_precompressed(self) -> None
    def rollback(self) -> None                               # ModuleTransactionError("operation_rollback_failed", details={"path":…, "error":…})
    def commit(self) -> None                                 # удаляет каталог операции целиком
```

Запись действий — упреждающая, в `actions.log` (одна JSON-строка на действие, `flush` + `os.fsync`) до изменения корня: `{"kind": "add"|"replace"|"remove"|"state", "path": rel}`. Копия прежнего файла: `os.link`, при `OSError` — `shutil.copy2`. Новый файл: `shutil.copy2` в `<цель>.xk-tx-new`, затем `os.replace`. `rollback` идёт по `actions.log` с конца: `add` — удалить, если есть; `replace`/`remove`/`state` — вернуть из `backup/`, если копия есть (нет копии при действии `replace` = действие не успело начаться, пропустить); хвостовая оборванная строка журнала игнорируется; оставшиеся `*.xk-tx-new` удаляются; опустевшие каталоги, созданные операцией, удаляются. `align_precompressed`: для каждой пары `X`, `X.gz` из `files_add` выставить `mtime` копии равным `mtime` исходника.

- [ ] **Step 1: Failing tests:**

```python
def test_apply_then_rollback_restores_tree_byte_for_byte(panel, journal): ...     # snapshot(panel) до == после
def test_rollback_is_idempotent(panel, journal): journal.rollback(); journal.rollback()
def test_rollback_after_partial_apply_and_reopen(panel): ...                      # Journal.open + rollback
def test_torn_last_line_of_actions_log_is_ignored(panel, journal): ...
def test_enospc_during_copy_rolls_back(panel, journal, monkeypatch):               # Review Focus 2
    monkeypatch.setattr(shutil, "copy2", raising_enospc_on_third_call)
    with pytest.raises(OSError): apply_all(journal)
    journal.rollback(); assert snapshot(panel) == before
def test_gz_is_not_older_than_source_after_align(panel, journal):                  # Review Focus 5
    ...; assert gz.stat().st_mtime >= src.stat().st_mtime
    assert resolve_precompressed_static(str(panel / "static"), "js/x.js", "gzip") is not None
def test_rollback_failure_reports_first_unrestored_path(panel, journal, monkeypatch): ...
def test_commit_removes_operation_directory(panel, journal): ...
def test_extract_rejects_traversal_absolute_and_links(tmp_path): ...               # три архива-фикстуры
def test_extract_takes_only_requested_files(tmp_path): ...
```

- [ ] **Step 2–4:** FAIL → реализация → PASS (на Windows `os.link` может не сработать — путь копирования обязан пройти те же тесты; добавить параметризацию с подменой `os.link` на бросающий).
- [ ] **Step 5: Commit** — «Замена файлов модуля ведётся с копией прежних и полным откатом».

### Task 7: State-файлы, manifest сборки и ход операции

**Files:**
- Create: `xkeen-ui/services/module_transactions/install_state.py`, `executor.py`
- Test: `tests/test_module_transactions_install_state.py`, `tests/test_module_transactions_executor.py`

**Interfaces:**
- Consumes: `Journal`, `Plan`, `OwnershipMap`, `extract_payload`, `ModuleCatalogClient.get_release_catalog`, `download_verified_archive`, `validate_module_archive`, `write_status`.
- Produces:

```python
# install_state.py
def rebuild_frontend_manifests(panel_root: Path, frontend: Mapping[str, Mapping[str, Any]]) -> dict[str, bytes]
# ключи: "static/frontend-build/.vite/manifest.json", "…/manifest.build.json"; запись остаётся, если её file есть на диске
def state_file_updates(panel_root: Path, state_dir: Path, plan: Plan) -> dict[str, bytes]
# module-installed.json: modules[id] = bool; modules.json: profile="custom", modules[id].enabled = bool (прочие поля сохранить);
# install-profile.json: profile="custom", module_ids = plan.installed_after (в порядке MODULE_IDS);
# install-managed.json: paths ± files_add/files_remove, отсортировано

# executor.py
def run_operation(journal: Journal, *, state_dir: Path, client: ModuleCatalogClient, architecture: str,
                  restart: Callable[[], None], wait_healthy: Callable[[str], bool],
                  on_step: Callable[[str], None] | None = None) -> str   # возвращает result
def wait_for_panel(health_url: str, state_dir: Path, module_id: str, operation: str, *, timeout_s: float,
                   sleep: Callable[[float], None] = time.sleep) -> bool
def recover(panel_root: Path, state_dir: Path) -> str | None   # result либо None, если делать нечего
```

`run_operation` проходит шаги спецификации по порядку, перед каждым — `journal.set_step` и `write_status`. `run_operation` принимает необязательный `on_step: Callable[[str], None]`, вызываемый в начале каждого шага; обрыв для тестов устраивает тестовый запускатель (Task 8), в продукте параметр не используется и переменных окружения для обрыва нет. Любое исключение до `applying` → каталог операции удаляется, итог `interrupted` c `error_code`. Исключение с `applying` и позже, либо `wait_healthy` вернул `False` → `journal.rollback()`, `restart()`, повторный `wait_healthy`; итог `rolled_back` (с `panel_unresponsive: true`, если панель не ответила) либо `rollback_failed` (каталог остаётся). `SIGTERM`: до `applying` — как исключение до `applying`, после — откат.

- [ ] **Step 1: Failing tests.** Фикстура `panel`: временный корень с `BUILD.json` (`version: "2.10.0"`), картой и state-файлами; релиз-фикстура с подписанным каталогом и архивами через поддельный transport (помощники из `tests/test_module_catalog_client.py`).

```python
def test_manifests_rebuilt_from_untouched_profile_equal_installer_output(real_tree_profile): ...   # skip без frontend-build
def test_manifest_gains_bridge_entry_when_its_file_appears(panel): ...
def test_state_files_after_install(panel): ...        # profile == "custom", module_ids, managed paths, enabled True
def test_state_files_after_remove(panel): ...
def test_install_commits_and_changes_only_manifest_files_and_state(panel, release):
    result = run_operation(journal, ..., restart=noop, wait_healthy=lambda _: True)
    assert result == "committed" and not journal.dir.exists()
    assert changed_paths(before, snapshot(panel)) <= set(plan.files_add) | STATE_PATHS
def test_remove_commits_and_leaves_other_modules_untouched(panel, release): ...
def test_health_failure_rolls_back_byte_for_byte(panel, release): ...   # wait_healthy: первый False, второй True
def test_health_failure_twice_reports_panel_unresponsive(panel, release): ...
def test_checksum_mismatch_leaves_root_untouched(panel, release): ...
def test_transport_drop_mid_download_leaves_root_untouched(panel, release): ...    # Review Focus 4
def test_wait_for_panel_requires_200_and_no_last_error(panel): ...                 # локальный http.server
def test_sigterm_before_applying_leaves_root_untouched(panel, release): ...        # linux_only
def test_sigterm_after_applying_rolls_back(panel, release): ...                    # linux_only
def test_apply_profile_after_install_keeps_module(panel_from_installer, release): ...  # повторный apply_profile Этапа 7 с profile="custom"
```

- [ ] **Step 2–4:** FAIL → реализация → PASS.
- [ ] **Step 5: Commit** — «Модуль ставится и удаляется одной операцией: при неудачном запуске панели всё возвращается».

### Task 8: Исполнитель, восстановление и запуск из панели

**Files:**
- Create: `xkeen-ui/scripts/module_transaction.py`, `xkeen-ui/services/module_transactions/launcher.py`
- Modify: `executor.py` (`recover`)
- Test: `tests/test_module_transactions_cli.py`, `tests/test_module_transactions_guardrails.py`

**Interfaces:**
- Consumes: всё из Task 4–7; `services.self_update.state.get_update_paths`, `try_acquire_lock`.
- Produces:
  - CLI: `module_transaction.py run --panel-root P --state-dir S --operation ID`, `recover --panel-root P --state-dir S`, `status --state-dir S` (печатает `status.json`); код выхода 0 для `committed`, `rolled_back`, «нечего делать»; 1 для `interrupted` и `rollback_failed`; 2 для ошибок вызова;
  - `launcher.launch(plan: Plan, *, panel_root: Path, state_dir: Path, health_url: str, restart_cmd: Sequence[str], python: str = sys.executable) -> str` — создаёт `Journal`, пишет `status.json` (`running`, `prepared`), запускает `run` оторванным процессом (`start_new_session=True`; на Windows `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`), возвращает `operation_id`;
  - `launcher.ensure_idle(panel_root, state_dir) -> None` — `operation_in_progress`, если есть каталог операции с живым `pid` либо занят замок самообновления; `operation_rollback_failed`, если последний итог `rollback_failed` и каталог существует.

`run` берёт общий замок самообновления (`try_acquire_lock(get_update_paths(state_dir)["lock_file"])`), записывает свой `pid` в `operation.json`, снимает замок в `finally`. Перезапуск — `restart_cmd` из `operation.json`; адрес проверки — `health_url` оттуда же. `recover`: нет каталога → `None`; `pid` из `operation.json` жив → `None` без изменений; шаг до `applying` → удалить каталог, `interrupted`; `committed` → удалить каталог; иначе `journal.rollback()` → `rolled_back` либо `rollback_failed`. Битый `operation.json`: если есть `actions.log` и `backup/` — откат по ним, иначе удалить каталог; итог `interrupted`. `recover` панель не перезапускает.

- [ ] **Step 1: Failing tests** (CLI запускается `subprocess.run([sys.executable, script, …])`; релиз раздаёт локальный HTTP-сервер, как CLI его находит — см. Step 3):

```python
@pytest.mark.parametrize("step", ["prepared", "downloading", "verifying", "applying", "state", "restarting", "health"])
def test_kill_at_step_then_recover_restores_tree(panel, release, step):
    run_test_runner(panel, "--fail-at", step)                           # код выхода 70
    assert run_cli_recover(panel).returncode in (0, 1)
    assert snapshot(panel) == before and Journal.find(panel.root) is None
    assert read_status(panel.state)["result"] == ("interrupted" if step in EARLY else "rolled_back")

def test_recover_is_noop_while_executor_is_alive(panel, release):               # Review Focus 1
    journal.set_pid(os.getpid()); journal.set_step("restarting")
    assert recover(panel.root, panel.state) is None and journal.dir.exists()

def test_recover_survives_corrupt_operation_json(panel, release): ...           # Review Focus 3, обе ветки
def test_recover_without_operation_directory_exits_zero(panel): ...
def test_run_refuses_when_self_update_lock_is_held(panel, release): ...         # operation_in_progress
def test_ensure_idle_blocks_after_rollback_failed(panel): ...
def test_launch_returns_id_and_status_reaches_committed(panel, release): ...    # ждать до 30 с
def test_engine_does_not_import_flask_or_routes(): ...                          # AST по services/module_transactions/*.py и scripts/module_transaction.py
def test_shipped_cli_has_no_test_hooks(): ...                                   # в тексте скрипта нет "keyring", "release-dir", "fail-at", "TESTING"
def test_engine_files_belong_to_core_in_both_ownerships(): ...                  # stage7.owner(...) == "core" и build_module_ownership
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.** В поставляемом `scripts/module_transaction.py` тестовых параметров нет: транспорт — всегда `UrlLibCatalogTransport`, ключи — встроенные, обрыва по переменной окружения нет. Для тестов, стенда и приёмки есть отдельный запускатель `tests/support/module_transaction_runner.py` (в архив панели не входит): те же команды `run`/`recover`, плюс `--release-dir` (файловый transport поверх каталога с релизом), `--keyring` (тестовый открытый ключ) и `--fail-at <step>` (`os._exit(70)` через `on_step`). Он импортирует `services.module_transactions.executor` и ничего не дублирует.
- [ ] **Step 4:** PASS; затем весь набор `python -m pytest tests/test_module_transactions_*.py tests/test_module_catalog_client.py -q`.
- [ ] **Step 5: Commit** — «Установку модуля ведёт отдельный процесс, а прерванная операция доигрывается сама».

### Task 9: `install.sh`

**Files:**
- Modify: `xkeen-ui/install.sh` (шаблон init-скрипта около `start_service`; место перед `apply` профиля; место после `commit` профиля)
- Test: `tests/test_installer_module_transaction_recovery.py`

**Interfaces:**
- Consumes: CLI `recover` из Task 8.
- Produces: три вставки.

В шаблоне init-скрипта, в `start_service` после проверки `PYTHON_BIN` и до запуска панели:

```sh
  MODULE_TX_ROOT="$UI_DIR.module-transactions"
  if [ -d "$MODULE_TX_ROOT" ] && [ -n "$(ls -A "$MODULE_TX_ROOT" 2>/dev/null)" ] \
      && [ -f "$UI_DIR/scripts/module_transaction.py" ]; then
    audit_boot "[start] unfinished module operation found, recovering"
    "$PYTHON_BIN" "$UI_DIR/scripts/module_transaction.py" recover \
      --panel-root "$UI_DIR" --state-dir "$UI_DIR" >/dev/null 2>&1 \
      || audit_boot "[start] module operation recovery failed (non-fatal)"
  fi
```

Перед `apply` профиля — тот же вызов с `|| true` и строкой в журнал установки. После `"$INSTALL_PROFILE_HELPER" commit` — `rm -rf "$UI_DIR.module-transactions"`. В `xkeen-ui/uninstall.sh` рядом с удалением каталога панели — удаление `$UI_DIR.module-transactions` (тест на строку).

- [ ] **Step 1: Failing tests:** текстовые проверки трёх вставок и их порядка (`recover` в установщике стоит до `apply`, уборка — после `commit`); под `linux_only` — исполняемый тест: вырезать `start_service` из сгенерированного init-скрипта не нужно, достаточно запустить фрагмент проверки каталога в `sh` с пустым и непустым каталогом и поддельным `python3`, записывающим свои аргументы.
- [ ] **Step 2–4:** FAIL → правка → PASS; `sh -n xkeen-ui/install.sh`.
- [ ] **Step 5: Commit** — «После обрыва питания роутер сам возвращает панель к состоянию до установки модуля», затем слепки отдельным коммитом.

### Task 10: Monaco по требованию на страницах копий и генератора

**Files:**
- Modify: `xkeen-ui/static/js/pages/backups.screen.bootstrap.js` (строка импорта `../ui/monaco_loader.js`), `xkeen-ui/static/js/pages/mihomo_generator.screen.bootstrap.js` (строка импорта `./editor_monaco.shared.js`), при необходимости `xkeen-ui/static/js/features/backups.js` и `mihomo_generator.js` (место `ensureEditorRuntime('monaco')`)
- Test: `tests/test_module_packages_over_installer_profiles.py`, `e2e/standalone_pages_lazy_monaco.spec.mjs`

**Interfaces:**
- Consumes: существующий ленивый путь главной панели — `panel.editor.monaco.bundle.js` (`activate()`), `XKeen.ui.editorCapabilities.has/ensure`.
- Produces: ни один из двух загрузочных скриптов не импортирует статически файлы с владельцем `editor-full`; при выборе Monaco страница зовёт тот же `ensure`, что главная панель; без Monaco в установке пункт Monaco в списке движков недоступен, страница остаётся на CodeMirror.

- [ ] **Step 1: Failing test сборки** (пропускается без сборки фронтенда):

```python
@pytest.mark.parametrize("profile", ["xray-minimal", "mihomo-minimal"])
def test_module_package_over_installer_profile_has_no_dangling_static_imports(profile, tmp_path):
    # apply_profile во временный корень; для каждого необязательного модуля вне профиля:
    # installed | ownership[module] должно содержать цель каждого статического ребра от файлов модуля:
    # импорт JS, импорт Python на уровне модуля, а также include/extends/import/from шаблона со строковым именем
    assert dangling == {}
```

Сейчас падает на двух связях из спецификации.
- [ ] **Step 2: Failing e2e.** Страницы `/backups` и `/mihomo_generator`: при открытии нет сетевых запросов к `monaco_loader.js`, `monaco_shared.js` и `static/monaco-editor/`; после выбора Monaco в списке движков редактор Monaco виден; в варианте редактора `light` пункт Monaco недоступен, предпросмотр работает на CodeMirror.
- [ ] **Step 3:** до правки прочитать `tests/test_frontend_migration_guardrails.py` (блок про `monaco_loader.js`) и `tests/test_modular_panel_stage6_editor_contract.py`; если тест автора закрепляет удаляемую строку импорта дословно — остановиться и сообщить пользователю.
- [ ] **Step 4: Implement.** Убрать два статических импорта; в местах переключения движка использовать тот же вызов, что `routing.js` и `mihomo_panel.js` (не писать второй загрузчик). JS править с сохранением CRLF.
- [ ] **Step 5:** `npm run frontend:build`; оба теста → PASS; `e2e/` спеки копий и генератора; пересобрать `docs/frontend-page-inventory.json` (`generate_frontend_inventory.py --json-out docs/frontend-page-inventory.json`) и слепки из Global Constraints.
- [ ] **Step 6:** замер: `apply_profile` для `mihomo-minimal` до и после — записать, на сколько байт уменьшился набор.
- [ ] **Step 7: Commit** — «Страницы копий и генератора Mihomo загружают Monaco только когда он нужен», слепки отдельным коммитом.

### Task 11: Контракт и документы

**Files:**
- Modify: `scripts/generate_modular_panel_stage8_contract.py`, `docs/modular-panel-stage8-contract.{json,md}` (генератором), `tests/test_modular_panel_stage8_contract.py`, `docs/modular-panel-stage8-official-module-manager.md`, `README-modular-panel-plan.md`

- [ ] **Step 1:** в тесте контракта заменить ожидания топологии: `payload_root` = `/opt/etc/xkeen-ui (ownership paths из manifest)`; нет ключей `active_pointer`, `pointer_switch`; `apply` = `journaled per-file replace with backup`; `registry` = `module-installed.json + module-ownership.json`; `transaction_root` = `/opt/etc/xkeen-ui.module-transactions/<operation-id>/`; строка `module-only-file-diff` — «change only manifest files of the selected module and state files»; новое правило `module_version_equals_panel_version`. → FAIL.
- [ ] **Step 2:** правка генератора, `python scripts/generate_modular_panel_stage8_contract.py --root .` → PASS.
- [ ] **Step 3:** в плане и описании Этапа 8 заменить абзацы о `modules/<id>/<version>/` и указателе на общий корень с журналом, добавить абзац о равенстве версий, о карте владения и о долге «установщик на карте пакетов» в 8.5. Подэтап 8.3 закрытым НЕ помечать — это после Task 13.
- [ ] **Step 4: Commit** — «Описание менеджера модулей приведено к тому, как он на деле устроен».

### Task 12: Проверка на настоящем дереве

**Files:**
- Test: `tests/test_module_transactions_real_tree.py` (пропускается без `xkeen-ui/static/frontend-build/.vite/manifest.json`)
- Create (не в git): `.tmp/smoke/run_module_tx.sh`

- [ ] **Step 1: Тест.** Собрать релиз `2.10.0` из копии дерева (со сжатием и картой), подписать тестовым ключом; `apply_profile(…, "xray-minimal")` во временный корень; для каждого из `tool.terminal`, `tool.files`, `tool.backups`, `integration.happ`, `tool.advanced-diagnostics`, `engine.mihomo`: `install` → `committed`, затем:
  - в `manifest.json` есть записи мостов, чьи файлы теперь на диске;
  - каждый `.gz` не старше исходника;
  - `remove` → `committed`, дерево отличается от исходного только state-файлами.
  То же для `mihomo-minimal` с `engine.xray`.
- [ ] **Step 2:** полный pytest из Bash; ожидание — прежние известные падения на Windows и ни одного нового.
- [ ] **Step 3: Браузер.** `.tmp/smoke/run_module_tx.sh <профиль> <модуль>`: установленный профиль из `run_installed.sh` + локальный HTTP-релиз + `module_transaction.py run` с тестовыми параметрами и командой перезапуска стенда; затем проба `audit7.mjs`: вход, обход вкладок, ошибок консоли и 4xx/5xx нет, раздел модуля работает. Прогнать циклом все двенадцать сочетаний «урезанный профиль + необязательный модуль вне профиля»: пять шаблонов подключают части через `page_context`, и статический сторож Task 10 их не видит. Порт стенда проверить до запуска; с полным e2e одновременно не гонять.
- [ ] **Step 4:** `npm run frontend:build` и полный e2e; ориентир — 0 failed при 12 skipped.
- [ ] **Step 5: Commit** теста — «Проверка: модуль из пакета работает поверх урезанной установки».

### Task 13: Приёмка на роутере (с пользователем)

Нужны: роутер, разрешённый пользователем; сборка с semver-версией и картой; каталог и пакеты той же версии, доступные исполнителю. Настоящего релиза с подписью ещё нет, поэтому на роутер временно копируются тестовый запускатель, каталог релиза и тестовый ключ; после приёмки они удаляются (сверка дерева панели с `git ls-tree`) — это оговаривается с пользователем до начала.

- [ ] **Step 1:** слепок роутера; `git log <версия роутера>..HEAD` на чужие коммиты.
- [ ] **Step 2:** установка `xray-minimal` через `install.sh` целиком; `install tool.terminal`; терминал открывается, статика модуля отдаётся с `Content-Encoding: gzip`.
- [ ] **Step 3:** `remove tool.terminal`; панель чистая, в `status.json` `committed`, каталога операции нет.
- [ ] **Step 4:** в пакет подложен файл модуля с синтаксической ошибкой в безусловно импортируемом месте → панель не отвечает → `rolled_back`, прежняя панель отвечает.
- [ ] **Step 5:** тестовый запускатель с `--fail-at applying`, перезагрузка роутера → после загрузки панель прежняя, в журнале запуска строка о восстановлении, загрузка не задержана.
- [ ] **Step 6:** `install tool.terminal`, затем обновление панели `install.sh` той же версии → терминал на месте, профиль `custom`.
- [ ] **Step 7:** повтор Step 2–3 на MIPS.
- [ ] **Step 8:** пометить 8.3 закрытым в `README-modular-panel-plan.md`, слепки, коммит; обновить память проекта; пуш — по команде пользователя.
