# Этап 8.0: контракты и границы

**Статус:** закрыт 2026-10-03. Это статический baseline для менеджера официальных модулей; updater, trust-клиент и UI относятся к следующим подэтапам.

## Источники истины

- Stage 0 inventory фиксирует состав модулей и размеры.
- Stage 7 installer profiles фиксирует legacy ownership и profile transaction.
- `ModuleRegistry` фиксирует API version, зависимости, конфликты и profile presets.
- `module_profile_install.py` остаётся консервативным классификатором legacy-файлов.

## Модули и legacy-границы

| ID | Dependencies | Restart | Removable |
| --- | --- | --- | --- |
| `core` | - | no | no |
| `engine.xray` | `core`, `tool.editor` | yes | yes |
| `engine.mihomo` | `core`, `tool.editor` | yes | yes |
| `tool.editor` | `core` | yes | yes |
| `tool.terminal` | `core` | yes | yes |
| `tool.files` | `core` | yes | yes |
| `tool.backups` | `core` | yes | yes |
| `integration.happ` | `core` | yes | yes |
| `tool.advanced-diagnostics` | `core` | yes | yes |

Legacy install root: `/opt/etc/xkeen-ui`. Managed payload roots: `core/`, `routes/`, `services/`, `static/`, `templates/`, `scripts/`.
State files, `secret.key`, runtime/config directories and Mihomo profiles/backups остаются пользовательскими данными.
Неизвестные или неоднозначные файлы по умолчанию принадлежат `core` и перед удалением попадают в quarantine.

## Топология пакетов

| Область | Контракт |
| --- | --- |
| `payload_root` | `/opt/etc/xkeen-ui (ownership paths from the module manifest)` |
| `apply` | `journaled per-file replace with backup` |
| `registry` | `module-installed.json + module-ownership.json` |
| `transaction_root` | `/opt/etc/xkeen-ui.module-transactions/<operation-id>/` |
| `user_data_root` | `var/ and declared core/engine config paths` |
| `module_version` | `equal to the installed panel release` |

Файлы модуля лежат в общем корне панели по путям из manifest: панель загружает код, статику и шаблоны только оттуда. Замена ведётся под журналом — прежний файл сохраняется в каталоге операции, и по журналу дерево возвращается в исходное состояние после любой ошибки или обрыва питания (Stage 8.3).
Какие файлы принадлежат модулю, панель знает из `module-ownership.json`: его пишет сборщик релиза, он лежит в panel archive и описывает то же дерево, из которого собраны module archives.
Модуль ставится только из релиза, версия которого равна версии установленной панели; переход на новую версию происходит вместе с панелью.
Module-only операция не меняет соседние модули, пользовательские конфигурации, ядра; профиль после неё становится `custom`. Profile transition остаётся отдельной транзакцией Stage 7.

## Catalog и manifest

Единственный обязательный канал — `stable` из allow-listed GitHub Releases официального репозитория. Ветки, пользовательские URL и arbitrary repositories запрещены.

Обязательные catalog keys: `id`, `version`, `channel`, `panel_api`, `module_api`, `min_core`, `architectures`, `requires`, `conflicts`, `requires_restart`, `archive`, `size`, `sha256`, `signing_key_id`.

Обязательные manifest keys: `schema_version`, `id`, `version`, `panel_api`, `module_api`, `requires`, `conflicts`, `min_core`, `architectures`, `channel`, `ownership`, `max_size`, `requires_restart`.
Архив отклоняется до распаковки при неизвестном signing_key_id, SHA-256 mismatch, API mismatch, path traversal, абсолютном пути, symlink escape или наличии install/uninstall shell hooks.
Статический preflight выполняет `services.module_package_contract`: source/catalog проверяются до скачивания, а `module-manifest.json` и точный allow-list `payload/` — до staging. Разрешены только directory и regular_file; symlink запрещён.

## Release assets 8.1

Сборщик `scripts/build_modular_panel_release.py` выпускает `xkeen-ui-panel-<version>.tar.gz`, `xkeen-module-<module-id>-<version>.tar.gz`, `catalog.json`, checksum sidecars `<asset>.sha256` и `release-metadata.json`.
Module archive содержит только `module-manifest.json` и `payload/<ownership-path>`; bootstrap hooks остаются в panel asset и не попадают в module payload.
Ownership сначала определяется Stage 7 по имени файла, затем замыкается по графу импортов: файл, который скрипт страницы импортирует статически или Python-файл импортирует на уровне модуля без условия, переносится в самый глубокий пакет, от которого зависят обе стороны (в худшем случае `core`). Dynamic `import()` и импорт под `if`/`try` или внутри функции зависимостью не считаются — так подключаются необязательные модули. Поэтому каждый пакет вместе со своими зависимостями из registry загружается без остальных пакетов.
Воспроизводимость фиксирует USTAR, POSIX-сортировку путей, uid/gid=0, пустые owner names и `SOURCE_DATE_EPOCH` для tar/gzip.
CI собирает и статически проверяет `dist/modular-panel/**` на каждом push. На tag build `scripts/sign_modular_panel_catalog.py` добавляет `catalog.json.sig` в `release-metadata.json`; публикация в GitHub Release разрешена только при `startsWith(github.ref, 'refs/tags/v')`. Legacy bootstrap archive `xkeen-ui-routing.tar.gz` сохраняется без изменения имени.
Версия релиза берётся из тега и обязана быть semver, поэтому теги выпускаются как `vX.Y.Z`, без буквенного суффикса (решение 5 октября 2026 года): на теге вида `v2.9.2a` сборщик останавливается с понятной ошибкой, и релиз не публикуется.

## Trust и клиент каталога 8.2

Core принимает только raw bytes `catalog.json`, проверенные `Ed25519` envelope `catalog.json.sig` с already-embedded key ID `release-2026`. Private key доступен только tag CI через environment `XKEEN_RELEASE_ED25519_PRIVATE_KEY` и не входит в assets.
Discovery ограничен `https://api.github.com/repos/umarcheh001/Xkeen-UI/releases/latest`; принимается только published stable `v<semver>` release. Client сам строит immutable GitHub Releases URLs, принимает HTTPS redirects только на `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com` и отвергает user URLs/branch selectors.
Последний проверенный catalog cache хранится atomically с правами `0600`: до `86400` секунд он fresh, а stale fallback разрешён только при transport failures only. `highest verified release version` запрещает downgrade. Archive bytes streamed во temporary file и сверяются по exact size/SHA-256 перед передачей будущему updater; unpack и transaction остаются 8.3.

## Compatibility и операции

Совместимость проверяется по `panel_api`, `module_api`, `min_core`, архитектуре, dependencies, conflicts и semver до скачивания/распаковки.
Установка не выполняется внутри Flask request thread: её ведёт отдельный процесс `scripts/module_transaction.py`, он же проверяет запуск панели и откатывает. Прерванную операцию отменяет init-скрипт перед стартом панели.

| Операция | Граница |
| --- | --- |
| module-only | файлы модуля из manifest, state-файлы, restart, health, commit или rollback |
| panel update | core-owned payload, backup и полный rollback |
| profile transition | Stage 7 transaction, diff, restart и rollback |

## Lifecycle API 8.4

Подэтап 8.4 закрыт 2026-10-06. `xkeen-ui/services/module_lifecycle.py` повторно строит authoritative plan и передаёт его в detached module transaction runner; Flask request не меняет файлы панели.
Допустимы только `install`, `repair`, `remove`, `panel-update`, `profile-transition`. Plan guard — lowercase SHA-256 of canonical server plan and dependency diff. Независимые версии модулей не входят в текущую модель релиза, поэтому module-only `update_available` всегда `false`.

| Method | Path | Success |
| --- | --- | --- |
| `GET` | `/api/modules/installed` | `200` |
| `GET` | `/api/modules/available` | `200` |
| `POST` | `/api/modules/operations/plan` | `200` |
| `POST` | `/api/modules/operations/apply` | `202` |
| `GET` | `/api/modules/operations/status` | `200` |
| `POST` | `/api/modules/operations/<operation_id>/cancel` | `202` |
| `POST` | `/api/modules/recovery` | `200` |
| `POST` | `/api/modules/restart` | `200` |

Cancel посылает SIGTERM только точному live runner после проверки journal, status и Linux `/proc/<pid>/cmdline`. Recovery не перезапускает панель автоматически; restart имеет отдельный guard от активной операции, update lock и rollback-failed state.

## Panel update и profile transition 8.5

Подэтап 8.5 закрыт 2026-10-07. Signed catalog теперь содержит обязательный panel descriptor: `archive`, `size`, `sha256`, `version`, `signing_key_id`, `architectures`.
`panel-update` использует scope `panel`, принимает только строго более новую stable-версию и заменяет весь managed target текущего профиля. `profile-transition` использует scope `profile`, остаётся на установленной версии и материализует профиль, сохранённый через `POST /api/modules/profile`.
Обе full-scope операции передают в plan/apply только `operation` и server-generated `plan_id`; `module_id` запрещён. Любое изменение release/profile между review и apply возвращает `operation_plan_stale`.
Profile response публикует `transition_required` и `transition_target`. Пока физический профиль не совпадает с желаемым, отдельный restart возвращает `profile_transition_required`.
Panel/profile journal сохраняет каждый заменённый или удалённый managed-файл и state; ошибка после apply вызывает полный rollback своего scope. `rollback_failed` блокирует новые операции до ручного восстановления backup. Module rollback, full-scope transaction rollback и legacy DevTools backup rollback не смешиваются.
Stable DevTools check/run/status делегируются `ModuleLifecycleService`; branch channel `main` сохраняет legacy development-only path. Подробные payload, error codes, cancel/recovery semantics и manual runbook: `docs/modular-panel-stage8-panel-profile.md`.
Stable full-scope codes: `panel_update_unavailable`, `panel_version_current`, `panel_archive_invalid`, `profile_transition_required`, `profile_transition_not_required`, `profile_payload_unavailable`, `profile_target_invalid`, `operation_free_space`.

## Acceptance matrix

| ID | Operation | Expected result |
| --- | --- | --- |
| `unknown-signing-key` | catalog trust | reject before display or download |
| `checksum-mismatch` | archive verification | reject before unpack and leave the panel tree untouched |
| `unsupported-api` | compatibility preflight | reject panel_api/module_api/min_core mismatch |
| `module-only-file-diff` | module-only update | change only manifest files of the selected module and state files |
| `panel-update-preserves-state` | panel update | preserve profile, modules.json, config and enabled state |
| `profile-transition-separate-transaction` | profile transition | use Stage 7 transaction path, never module-only path |
| `offline-cached-catalog` | catalog fetch | use last successful cache and expose stale/error state |
| `archive-path-safety` | manifest validation | reject traversal, absolute paths, symlink escape and hooks |
| `stable-release-reproducibility` | release assets | rebuild the same catalog/archive/checksum from CI inputs |

## Отложено

Произвольные репозитории, marketplace, пользовательские archive URLs, delta updates, автоматическое удаление зависимостей, shell hooks и OCI registry не входят в MVP.

Snapshot пересобирается командой `python .\scripts\generate_modular_panel_stage8_contract.py --root .`.
