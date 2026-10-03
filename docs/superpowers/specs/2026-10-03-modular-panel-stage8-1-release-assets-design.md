# Stage 8.1: упаковка и release assets

## Цель

Добавить воспроизводимую сборку официальных артефактов модульной панели:
единого panel archive, self-contained module archives, generated manifests,
catalog и SHA-256 metadata. Сборка должна использовать границы Stage 8.0 и
оставлять загрузку, криптографическую подпись и updater следующим подэтапам.

## Scope

В scope входят:

- deterministic tar builder с POSIX-путями, сортировкой, фиксированными uid/gid
  и mtime;
- panel asset `xkeen-ui-panel-<version>.tar.gz`;
- module assets `xkeen-module-<module-id>-<version>.tar.gz`;
- manifest с ownership allow-list в каждом module archive;
- `catalog.json`, SHA-256 files и release metadata;
- статический preflight каждого сгенерированного module archive через Stage 8.0;
- CI workflow для tag build, workflow artifacts и GitHub Release assets;
- byte-for-byte и ownership regression tests.

## Non-goals

Подэтап не добавляет сетевой catalog client, GitHub download, Ed25519
verification, key rotation, updater transactions, restart/rollback engine или
panel UI. Произвольные репозитории, пользовательские URLs, delta updates и
shell hooks остаются запрещёнными.

## Artifacts

Каждый tagged release публикует:

- `xkeen-ui-panel-<version>.tar.gz` и его `.sha256`;
- `xkeen-module-<module-id>-<version>.tar.gz` и его `.sha256` для каждого
  официального module id;
- `catalog.json` и `catalog.json.sha256`;
- `release-metadata.json` с version, source commit и списком assets.

Panel archive сохраняет legacy-compatible payload для bootstrap/install.sh.
Module archive имеет строгое содержимое:

```text
module-manifest.json
payload/<manifest ownership paths>
```

В archive допускаются только directory и regular_file. Symlink, hardlink,
absolute path, `..`, shell hooks и файлы вне `payload/` запрещены.

## Ownership

Builder получает module ownership из Stage 0 inventory, Stage 7 legacy
classifier и Module Registry. Core-owned runtime maps, state files,
пользовательские конфигурации, ядра и legacy user prefixes не попадают в
removable module archives. Неизвестный путь останавливает сборку, а не
назначается модулю молча.

Panel archive является единственным артефактом, который может содержать
общий core payload и legacy installer files. Это не меняет ownership
contract для будущих module-only updates.

## Determinism

Архив строится из нормализованного списка POSIX-relative paths. Для каждого
tar member фиксируются uid=0, gid=0, uname/gname пустые и mtime из явного
`SOURCE_DATE_EPOCH` (по умолчанию timestamp commit/release input). Список
member сортируется лексикографически; gzip header также получает стабильный
mtime. Повторная сборка при одинаковых inputs обязана дать идентичные bytes,
SHA-256 и catalog.

## Catalog

Catalog использует schema и required fields Stage 8.0. Для каждого module
entry archive, size и SHA-256 вычисляются из фактически созданного файла.
Канал только `stable`; module dependencies/conflicts и `requires_restart`
берутся из Module Registry. Builder не создаёт подпись, но оставляет
`signing_key_id` в контрактном поле для следующего подэтапа.

## CI

Tag workflow выполняет в фиксированном порядке:

1. checkout commit;
2. установить build dependencies;
3. собрать frontend и generated inventories;
4. запустить deterministic builder;
5. проверить assets, catalog и manifests Stage 8.0 preflight;
6. загрузить workflow artifact bundle;
7. создать или обновить GitHub Release и загрузить полный список assets.

Для обычного push выполняется build/test validation без публикации Release.
Существующий `xkeen-ui-routing.tar.gz` остаётся bootstrap artifact до миграции
установщика на panel asset.

## Verification

Тесты проверяют:

- byte-for-byte reproducibility;
- стабильные member metadata и отсутствие host paths;
- module ownership exact match;
- запрет core/user state, symlink, traversal и hooks;
- catalog/checksum consistency;
- legacy archive compatibility;
- workflow asset list, tag gating и upload/checksum steps.

Критерий завершения 8.1: локальный builder и CI публикуют один и тот же
набор воспроизводимых panel/module assets, которые проходят Stage 8.0 static
preflight, а каталог содержит точные размеры и SHA-256 всех архивов.
