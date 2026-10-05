# Stage 8.2: trust и клиент каталога

## Цель

Добавить core-owned клиент официального каталога модулей. Он получает только
подписанный stable-каталог Xkeen UI, сохраняет последний успешный результат и
готовит проверенный archive input для transaction/updater engine Этапа 8.3.
Неподписанные, подменённые, устаревшие или полученные с постороннего источника
данные не пересекают эту границу.

## Scope

Подэтап включает:

- Ed25519-подпись точных bytes `catalog.json` в GitHub Actions;
- embedded public-key ring с `signing_key_id`, включая ротацию ключей;
- allow-listed HTTPS discovery и immutable GitHub Release URLs;
- полную проверку catalog schema, Stage 8.0 package contract и SemVer;
- атомарный локальный cache последнего проверенного каталога;
- fresh/stale/offline policy и anti-rollback floor;
- streaming download archive с проверкой размера и SHA-256 до распаковки;
- unit и integration-тесты CI signing, trust, network policy и cache.

## Non-goals

Подэтап не добавляет Flask API, panel UI, notifications, установку, распаковку,
pointer switch, registry transaction, restart или rollback. Он не принимает
custom URLs, произвольные GitHub repositories, pre-release/dev channels,
marketplace entries, delta updates и executable hooks.

## Signing и keyring

`cryptography` является runtime и CI dependency для Ed25519. Закрытый ключ
хранится только как GitHub Actions secret `XKEEN_RELEASE_ED25519_PRIVATE_KEY`
в PEM-формате. Первичный key ID: `release-2026`; public key встроен в
`core`. Закрытый ключ не записывается в release assets, logs, test fixtures или
репозиторий.

После deterministic builder CI запускает отдельный signer. Он подписывает
неизменённые bytes `catalog.json` и выпускает `catalog.json.sig`:

```json
{
  "schema_version": 1,
  "algorithm": "Ed25519",
  "key_id": "release-2026",
  "signature": "base64-ed25519-signature"
}
```

`catalog.json.sig` добавляется в `release-metadata.json`, проверяется до
publication и загружается в тот же GitHub Release. Signature envelope не
является источником новых keys: `key_id` должен уже существовать в embedded
keyring.

Ротация выполняется только через обновление core:

1. release core содержит старый и новый public key;
2. CI переключается на новый secret и `key_id`;
3. оба key остаются embedded не менее 30 календарных дней после первого
   каталога, подписанного новым key;
4. после этого отдельный core release удаляет старый key.

Ключи не получают сроков действия, зависящих от router clock. Неизвестный,
неверный или неподдерживаемый key/algorithm всегда завершается fail-closed.

## Trusted catalog

Клиент получает последнюю stable release только через
`https://api.github.com/repos/umarcheh001/Xkeen-UI/releases/latest`, принимает
только non-draft/non-prerelease tag `v<semver>` и сам строит immutable URLs:

```text
https://github.com/umarcheh001/Xkeen-UI/releases/download/v<semver>/catalog.json
https://github.com/umarcheh001/Xkeen-UI/releases/download/v<semver>/catalog.json.sig
```

Discovery response не является trust input: доверие возникает только после
проверки подписи fixed release assets. Initial catalog/signature URLs всегда
имеют HTTPS, `github.com`, официальный owner/repository и versioned release
path. Разрешены только HTTPS redirects на `github.com`,
`objects.githubusercontent.com` или `release-assets.githubusercontent.com`.
Redirect на HTTP, другой host, ветку, query-selected catalog или произвольный
path отклоняется.

Клиент проверяет подпись над raw bytes до JSON decoding. Затем он требует:

- top-level `schema_version == 1`, `channel == "stable"` и корректный
  `release_version`;
- совпадение `release_version` с versioned URL;
- уникальные module IDs и прохождение каждой записи через Stage 8.0
  `validate_catalog_entry`;
- одинаковый `signing_key_id` во всех entries и envelope;
- SemVer без downgrade относительно самой новой ранее доверенной cache version.

Подписанный catalog покрывает точные size и SHA-256 всех archive assets. URL
архива формируется клиентом из trusted release version и allow-listed filename
записи; `catalog.json` не может задать сетевой адрес архива.

## Cache и отказ

В `ui_state_dir/module-catalog/catalog-cache.json` хранится один атомарный
record: raw catalog bytes, signature envelope, source release URL/version и
`fetched_at`. Права файла `0600`. При каждом cache read signature, key,
catalog schema и source/version проверяются повторно; локальная порча никогда
не становится trusted catalog.

Cache младше 24 часов имеет статус `fresh`. При timeout, DNS/TLS/HTTP transport
failure или offline клиент возвращает только последний успешно верифицированный
record со статусом `stale` и sanitised reason. При подписи, key, schema,
source или version-rollback failure cache не маскирует атаки: normal catalog
result не возвращается, а вызывающий слой получает явный trust error.

Если нет проверенного cache, transport failure завершается
`catalog_unavailable`. Планируемые error codes включают
`catalog_source_not_official`, `catalog_signature_invalid`,
`catalog_signing_key_unknown`, `catalog_schema_invalid`,
`catalog_version_rollback`, `catalog_cache_invalid` и
`catalog_archive_checksum_mismatch`.

## Archive input для Этапа 8.3

Клиент предоставляет verifier/download boundary, но не производит install.
Archive streamed во временный файл под управлением вызывающего engine; клиент
ограничивает read объявленным размером, сверяет exact size и SHA-256 с trusted
entry и удаляет временный файл при любой ошибке. Только после успешной сверки
возвращается path проверенного файла. Safe unpack, manifest inspection,
transactions, activation и rollback остаются в 8.3.

## Code boundaries

- `services/module_catalog_trust.py` — embedded keys, envelope parser и
  Ed25519 verification.
- `services/module_catalog_client.py` — discovery, redirect policy, trusted
  catalog validation, cache, SemVer floor и verified archive download.
- `services/module_package_contract.py` — публичный SemVer comparison и
  full-catalog structural validation поверх существующего entry/archive
  preflight.
- `scripts/sign_modular_panel_catalog.py` — CI-only signer, который читает
  private key только из environment и обновляет release metadata.
- `.github/workflows/build-user-archive.yml` — tag-only signing, signature
  verification и publication of `catalog.json.sig`.

Ни routes, ни templates, ни frontend bundles не импортируют этот сервис на
данном подэтапе.

## Verification

Тесты покрывают:

- валидную подпись, изменённые catalog bytes, malformed envelope, неизвестный
  key и неправильный algorithm;
- envelope/catalog `signing_key_id` mismatch и ротацию с двумя embedded keys;
- запрет non-HTTPS, wrong repository, mutable URL, unsafe redirect и
  prerelease discovery;
- malformed/duplicate catalog entry, source-version mismatch и SemVer rollback;
- fresh cache, offline stale cache, no-cache offline, tampered on-disk cache и
  refusal cache fallback после trust failure;
- archive size/SHA mismatch и удаление partial temporary download;
- tag-gated CI signing, metadata asset list и отсутствие private material в
  source or artifacts.

Критерий завершения 8.2: любой consumer получает только signature-verified
stable catalog либо ранее проверенный stale cache при transport outage; archive
bytes, отличающиеся от подписанного catalog, никогда не достигают updater.
