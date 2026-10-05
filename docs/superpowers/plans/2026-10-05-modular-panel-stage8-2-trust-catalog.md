# Stage 8.2 Trust and Catalog Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the core accept only a signed, stable Xkeen UI module catalog from an immutable GitHub Release, retain a verified cache for transport outages, and return only byte-verified archive input to the future Stage 8.3 transaction engine.

**Architecture:** The deterministic Stage 8.1 builder remains unsigned and offline. A tag-only CI signer signs the exact `catalog.json` bytes with an Ed25519 secret, emits a small signature envelope, and updates the release metadata before the existing publication step. Router-side code separates the cryptographic trust boundary, pure catalog contract validation, and I/O client. The client discovers a stable release through the GitHub API, constructs immutable official URLs itself, verifies before decoding, revalidates persisted cache data on every read, and streams an archive into a temporary file with an exact size/SHA-256 check.

**Tech Stack:** Python 3.11, `cryptography` Ed25519 primitives, Python standard library (`urllib`, `hashlib`, `json`, `tempfile`, `base64`, `pathlib`), existing atomic JSON writer, pytest, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-05-modular-panel-stage8-2-trust-catalog-design.md`

## Global Constraints

- The only discovery endpoint is `https://api.github.com/repos/umarcheh001/Xkeen-UI/releases/latest`; API metadata is never itself trusted catalog content.
- Accept only a non-draft, non-prerelease `v<semver>` release and construct `catalog.json`, `catalog.json.sig`, and archive URLs from that tag and the official GitHub Releases path.
- `catalog.json` is verified as exact raw bytes before JSON decoding. `catalog.json.sig` is an envelope, never a source of public keys.
- The embedded keyring initially contains only `release-2026` and the approved public Ed25519 key. Private key material is read only from `XKEEN_RELEASE_ED25519_PRIVATE_KEY` inside a tag-gated GitHub Actions step; it is never committed, logged, put in fixtures, or added to an artifact.
- Key rotation is core-first: ship old and new public keys together, retain both for at least 30 calendar days after first using the new key, and only then remove the old key in a later core release.
- Redirects must remain HTTPS and may terminate only on `github.com`, `objects.githubusercontent.com`, or `release-assets.githubusercontent.com`; initial catalog/archive URLs must be the official, versioned `github.com/umarcheh001/Xkeen-UI/releases/download/v<semver>/...` path without query or fragment.
- A fresh cache is at most 24 hours old. Only a validated cache may be used stale after a transport failure. Signature, key, URL, schema, or rollback failures must never be hidden by the cache.
- Remote release versions may equal or exceed the newest verified cache version but never downgrade below it.
- Archive URLs are constructed from the trusted release version and a validated filename. The catalog never supplies a network URL. Stream to a temporary file, enforce the declared size, verify SHA-256, and delete partial data on every failure.
- Stage 8.2 has no Flask route, template, browser bundle, notification, installer/update transaction, unpack, activation, restart, or rollback behavior.

## File Structure

```text
xkeen-ui/
  services/
    module_package_contract.py          # existing entry/archive preflight; add full-catalog and SemVer APIs
    module_catalog_trust.py             # new embedded keyring and Ed25519 envelope verification
    module_catalog_client.py            # new discovery, redirect policy, cache, and verified download client
  install.sh                            # install and verify the mandatory cryptography runtime dependency
scripts/
  sign_modular_panel_catalog.py         # new CI-only catalog signer
.github/workflows/
  build-user-archive.yml                # tag-gated signer and trust-aware release validation
tests/
  test_module_package_contract.py       # extend SemVer/full-catalog coverage
  test_module_catalog_trust.py          # new raw-byte signature and keyring coverage
  test_install_terminal_ui.py           # extend installer dependency assertions
  test_modular_panel_catalog_signer.py  # new CLI/metadata signer coverage
  test_module_catalog_client.py         # new discovery, cache, redirect, rollback, archive download coverage
  test_modular_panel_release_workflow.py# extend workflow boundary assertions
  test_modular_panel_stage8_contract.py # extend generated-contract assertions
docs/
  modular-panel-stage8-contract.{json,md}
  README.md
  superpowers/specs/2026-10-05-modular-panel-stage8-2-trust-catalog-design.md
  superpowers/plans/2026-10-05-modular-panel-stage8-2-trust-catalog.md
README-modular-panel-plan.md
requirements-dev.txt
```

---

### Task 1: Extend the Pure Catalog Contract

**Files:**
- Modify: `xkeen-ui/services/module_package_contract.py`
- Modify: `tests/test_module_package_contract.py`

**Interfaces:**

```python
def validate_semver(value: object, label: str) -> str: ...
def compare_semver(left: str, right: str) -> int: ...
def validate_catalog_document(
    document: Mapping[str, Any],
    *,
    release_version: str,
    signing_key_id: str,
    trusted_signing_key_ids: AbstractSet[str] | None = None,
    platform_architecture: str | None = None,
    core_version: str | None = None,
) -> dict[str, Any]: ...
```

- [ ] **Step 1: Write failing full-catalog and SemVer tests**

  Add a `_catalog_document()` fixture around the existing `_catalog()` entry. Cover canonical SemVer ordering, including `1.0.0-alpha < 1.0.0 < 1.0.1`; duplicate module IDs; a non-list `modules`; missing top-level keys; non-stable channel; source/URL version mismatch; an empty catalog; and an entry `signing_key_id` that differs from the verified envelope key.

- [ ] **Step 2: Run the focused tests and confirm the missing public interfaces**

  Run: `python -m pytest -q tests/test_module_package_contract.py -k "semver or document"`

  Expected: import/attribute failures for `compare_semver` and `validate_catalog_document`.

- [ ] **Step 3: Expose and reuse the existing SemVer parser**

  Rename or wrap `_semver` as `validate_semver`; make the existing internal comparison use the public `compare_semver` rather than duplicate ordering behavior. `compare_semver` must validate both operands and return exactly `-1`, `0`, or `1`, with a final release ordered after its matching prerelease.

- [ ] **Step 4: Implement top-level catalog validation**

  Require exactly the trusted Stage 8.1 shape: `schema_version == 1`, `release_version`, `channel == "stable"`, non-empty `source_commit`, and a non-empty `modules` list. Normalize and compare `release_version` with the caller's URL-derived version. Validate each entry through `validate_catalog_entry`, reject duplicate IDs, and require every normalized entry to use the verified envelope `signing_key_id`. Return a new normalized document rather than mutating the decoded input.

- [ ] **Step 5: Run the focused contract suite**

  Run: `python -m pytest -q tests/test_module_package_contract.py`

- [ ] **Step 6: Commit the pure contract boundary**

  ```bash
  git add xkeen-ui/services/module_package_contract.py tests/test_module_package_contract.py
  git commit -m "feat(modules): validate signed catalog documents"
  ```

### Task 2: Add the Ed25519 Trust Boundary and Runtime Dependency

**Files:**
- Modify: `requirements-dev.txt`
- Modify: `xkeen-ui/install.sh`
- Create: `xkeen-ui/services/module_catalog_trust.py`
- Create: `tests/test_module_catalog_trust.py`
- Modify: `tests/test_install_terminal_ui.py`
- Modify: `xkeen-ui/services/module_package_contract.py`

**Interfaces:**

```python
@dataclass(frozen=True, slots=True)
class CatalogSignature:
    schema_version: int
    algorithm: str
    key_id: str
    signature: bytes

class CatalogTrustError(ValueError):
    code: str
    details: Mapping[str, Any]

TRUSTED_CATALOG_PUBLIC_KEYS: Mapping[str, bytes]
TRUSTED_SIGNING_KEY_IDS: frozenset[str]

def parse_catalog_signature(raw_envelope: bytes) -> CatalogSignature: ...
def verify_catalog_signature(
    catalog_bytes: bytes,
    raw_envelope: bytes,
    *,
    keyring: Mapping[str, bytes] = TRUSTED_CATALOG_PUBLIC_KEYS,
) -> CatalogSignature: ...
```

- [ ] **Step 1: Write failing cryptographic tests**

  Generate ephemeral Ed25519 test keys in memory. Assert that a valid envelope verifies exact catalog bytes; one changed catalog byte fails; malformed JSON/base64, unknown key IDs, a non-`Ed25519` algorithm, an invalid schema, and a truncated signature fail closed with stable error codes. Pass a two-key injected keyring to prove the verifier supports overlap during rotation.

  Add installer/dependency assertions that `cryptography` is listed in `requirements-dev.txt`, `install.sh` probes `import cryptography`, attempts installation through the existing pip fallback helper, and performs a fatal final import check separate from optional `gevent` handling.

- [ ] **Step 2: Run the new trust tests and observe the expected import failure**

  Run: `python -m pytest -q tests/test_module_catalog_trust.py`

  Expected: collection fails because `services.module_catalog_trust` and its `cryptography` dependency do not exist.

- [ ] **Step 3: Declare and install `cryptography` explicitly**

  Add a bounded `cryptography` requirement compatible with Python 3.11 to `requirements-dev.txt`. In `install.sh`, introduce `NEED_CRYPTOGRAPHY`; install it with `pip_install_with_fallback` only when absent and call `fail_install` when it still cannot be imported. Keep Flask required and gevent/gevent-websocket optional exactly as they are. Update the manual remediation commands to mention the trust dependency without printing secrets.

- [ ] **Step 4: Implement the keyring and signature parser**

  Embed only the approved `release-2026` public PEM key in `module_catalog_trust.py`. Decode envelope JSON as UTF-8, require the exact keys and values below, use `base64.b64decode(..., validate=True)`, and reject unsupported/unknown values before cryptographic verification:

  ```json
  {"schema_version":1,"algorithm":"Ed25519","key_id":"release-2026","signature":"..."}
  ```

  Load the selected PEM with `serialization.load_pem_public_key`, require `Ed25519PublicKey`, and call `verify(signature, catalog_bytes)`. Convert all parser/key/signature failures to `CatalogTrustError` codes such as `catalog_signature_invalid` and `catalog_signing_key_unknown`; do not expose key bytes or backend exception strings.

- [ ] **Step 5: Make the static contract use the same key IDs**

  Replace the local `TRUSTED_SIGNING_KEY_IDS` literal in `module_package_contract.py` with the exported immutable set from the trust module. This keeps the entry preflight, generated Stage 8 contract, and runtime verifier on one key-id source of truth without giving the package contract any signing capability.

- [ ] **Step 6: Install the development dependency and run trust/contract tests**

  Run:

  ```bash
  python -m pip install -r requirements-dev.txt
  python -m pytest -q tests/test_module_catalog_trust.py tests/test_module_package_contract.py
  ```

- [ ] **Step 7: Commit the trust primitive**

  ```bash
  git add requirements-dev.txt xkeen-ui/install.sh xkeen-ui/services/module_catalog_trust.py xkeen-ui/services/module_package_contract.py tests/test_module_catalog_trust.py tests/test_install_terminal_ui.py
  git commit -m "feat(modules): verify signed catalog bytes"
  ```

### Task 3: Sign the Catalog in Tag CI and Publish Its Envelope

**Files:**
- Create: `scripts/sign_modular_panel_catalog.py`
- Create: `tests/test_modular_panel_catalog_signer.py`
- Modify: `.github/workflows/build-user-archive.yml`
- Modify: `tests/test_modular_panel_release_workflow.py`
- Modify: `tests/test_modular_panel_release_builder.py`

**Interfaces:**

```text
python scripts/sign_modular_panel_catalog.py \
  --catalog dist/modular-panel/catalog.json \
  --metadata dist/modular-panel/release-metadata.json \
  --key-id release-2026 \
  --private-key-env XKEEN_RELEASE_ED25519_PRIVATE_KEY
```

- [ ] **Step 1: Write failing signer and workflow tests**

  In a temporary release directory, create deterministic catalog bytes and metadata, pass an ephemeral private PEM through the named environment variable, and assert the script writes a canonical UTF-8 `catalog.json.sig`, verifies via `verify_catalog_signature`, and adds exactly one sorted `catalog.json.sig` entry to metadata. Assert missing/malformed/private non-Ed25519 keys fail without creating or modifying an asset.

  Extend workflow tests to assert the signer is after the modular builder, is gated by `startsWith(github.ref, 'refs/tags/v')`, receives only `${{ secrets.XKEEN_RELEASE_ED25519_PRIVATE_KEY }}` through the environment, verifies the signature before publication, includes the sidecar through `release-metadata.json`, and leaves branch builds unsigned.

- [ ] **Step 2: Run focused tests and verify they fail before the signer exists**

  Run: `python -m pytest -q tests/test_modular_panel_catalog_signer.py tests/test_modular_panel_release_workflow.py`

- [ ] **Step 3: Implement a CI-only signer with no private-key persistence**

  Read the named environment variable once, reject blank/missing values, load it using `serialization.load_pem_private_key`, and require `Ed25519PrivateKey`. Sign the unmodified `catalog.json` bytes. Write the envelope with `sort_keys=True`, compact separators, and one final newline, then atomically replace `catalog.json.sig`. Parse `release-metadata.json`, append the signature filename only once, sort `assets`, and atomically rewrite metadata. Never print secret values, PEM parsing errors, or signature material.

- [ ] **Step 4: Add tag-only signing and post-sign verification to CI**

  Add a `Sign modular panel catalog` step immediately after the builder, guarded by the exact tag condition. Keep non-tag builds without a signature asset. Extend the existing validation shell block to:

  1. import `verify_catalog_signature`;
  2. require and verify `catalog.json.sig` for tags;
  3. reject a signature asset on branch builds;
  4. compare actual asset names with updated metadata only after signing.

  The existing `gh release create/upload` already reads metadata, so it uploads the signature without a separate duplicated list.

- [ ] **Step 5: Run signer, workflow, and release-builder tests**

  Run: `python -m pytest -q tests/test_modular_panel_catalog_signer.py tests/test_modular_panel_release_workflow.py tests/test_modular_panel_release_builder.py`

- [ ] **Step 6: Commit CI signing**

  ```bash
  git add scripts/sign_modular_panel_catalog.py tests/test_modular_panel_catalog_signer.py .github/workflows/build-user-archive.yml tests/test_modular_panel_release_workflow.py tests/test_modular_panel_release_builder.py
  git commit -m "ci(release): sign modular catalog on tags"
  ```

### Task 4: Implement Official Discovery and Strict Transport Policy

**Files:**
- Create: `xkeen-ui/services/module_catalog_client.py`
- Create: `tests/test_module_catalog_client.py`

**Interfaces:**

```python
OFFICIAL_REPOSITORY = "umarcheh001/Xkeen-UI"
LATEST_RELEASE_URL = "https://api.github.com/repos/umarcheh001/Xkeen-UI/releases/latest"
CATALOG_REDIRECT_HOSTS = frozenset({
    "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com",
})

class CatalogClientError(ValueError):
    code: str
    details: Mapping[str, Any]

class CatalogTransportError(CatalogClientError): ...

@dataclass(frozen=True, slots=True)
class FetchPolicy:
    initial_hosts: frozenset[str]
    redirect_hosts: frozenset[str]
    require_official_release_path: bool

class CatalogTransport(Protocol):
    def fetch_bytes(self, url: str, *, max_bytes: int, policy: FetchPolicy) -> bytes: ...
    def stream_to(self, url: str, output: BinaryIO, *, max_bytes: int, policy: FetchPolicy) -> int: ...

class UrlLibCatalogTransport:
    def fetch_bytes(self, url: str, *, max_bytes: int, policy: FetchPolicy) -> bytes: ...
    def stream_to(self, url: str, output: BinaryIO, *, max_bytes: int, policy: FetchPolicy) -> int: ...

def official_release_asset_url(release_version: str, filename: str) -> str: ...
def parse_latest_release(payload: Mapping[str, Any]) -> str: ...
```

- [ ] **Step 1: Write failing discovery and redirect policy tests**

  Use an injected fake transport to verify that discovery calls the exact API endpoint and ignores all discovery-provided asset URLs. Cover draft/prerelease releases, `v1.2`, malicious/malformed tags, HTTP URLs, wrong owner/repository, branch URLs, mutable query/fragment URLs, redirect to HTTP or an unapproved host, redirect-loop exhaustion, catalog/signature byte-size limits, and the allowed GitHub asset redirect hosts.

- [ ] **Step 2: Run the focused tests and confirm the client module is missing**

  Run: `python -m pytest -q tests/test_module_catalog_client.py -k "discovery or redirect or source"`

- [ ] **Step 3: Implement fixed release URL helpers and discovery parsing**

  Build every release path from a validated SemVer release version and a filename without slash/backslash. Require the API JSON to be an object with `draft is False`, `prerelease is False`, and `tag_name == "v" + release_version`. Apply `validate_catalog_source` to the generated catalog URL; do not trust `assets`, `browser_download_url`, `tarball_url`, or body text in discovery metadata.

- [ ] **Step 4: Implement manual redirect handling**

  Use `urllib` with automatic redirects disabled. Before the first request, validate scheme/host/path against a `FetchPolicy`; on each `301`, `302`, `303`, `307`, or `308`, resolve `Location`, require HTTPS and an allowed host, and follow at most three redirects. Treat malformed Location, unexpected status, TLS/DNS/timeout, and byte-limit overflow as `CatalogTransportError` with sanitized details. Never forward arbitrary query-selected catalog URLs.

- [ ] **Step 5: Run focused policy tests**

  Run: `python -m pytest -q tests/test_module_catalog_client.py -k "discovery or redirect or source"`

- [ ] **Step 6: Commit the official network boundary**

  ```bash
  git add xkeen-ui/services/module_catalog_client.py tests/test_module_catalog_client.py
  git commit -m "feat(modules): restrict catalog discovery and redirects"
  ```

### Task 5: Implement Verified Catalog Retrieval, Cache, and Anti-Rollback

**Files:**
- Modify: `xkeen-ui/services/module_catalog_client.py`
- Modify: `tests/test_module_catalog_client.py`
- Reference: `xkeen-ui/services/io/atomic.py`

**Interfaces:**

```python
@dataclass(frozen=True, slots=True)
class CatalogSnapshot:
    catalog: Mapping[str, Any]
    catalog_bytes: bytes
    signature_bytes: bytes
    release_version: str
    catalog_url: str
    fetched_at: float
    freshness: Literal["fresh", "stale"]
    stale_reason: str | None

class ModuleCatalogClient:
    def __init__(
        self,
        ui_state_dir: str | os.PathLike[str],
        *,
        transport: CatalogTransport | None = None,
        now: Callable[[], float] = time.time,
        cache_ttl_s: float = 24 * 60 * 60,
        platform_architecture: str | None = None,
        core_version: str | None = None,
    ) -> None: ...

    def get_catalog(self, *, force_refresh: bool = False) -> CatalogSnapshot: ...
```

- [ ] **Step 1: Write failing cache, trust-order, and rollback tests**

  With a deterministic fake clock and transport, prove that:

  - valid remote catalog/signature bytes are verified before JSON decoding and produce a fresh snapshot;
  - a cache under 24 hours is returned without a network request;
  - an expired valid cache is returned only as `stale` after a timeout/DNS/TLS/HTTP transport error;
  - no cache plus transport failure raises `catalog_unavailable`;
  - a tampered raw catalog/signature/cache record is not returned;
  - a remote signature, source, schema, key, or rollback failure does not fall back to cache;
  - an older validly signed release than the highest verified cached release raises `catalog_version_rollback`.

- [ ] **Step 2: Run focused retrieval tests and verify expected failures**

  Run: `python -m pytest -q tests/test_module_catalog_client.py -k "cache or rollback or verified"`

- [ ] **Step 3: Define the on-disk cache record and atomic persistence**

  Store exactly one record at `ui_state_dir/module-catalog/catalog-cache.json`, mode `0600`, using `services.io.atomic._atomic_write_json`. Preserve raw catalog and envelope bytes with base64 encoding plus `catalog_url`, `release_version`, and `fetched_at`; do not reserialize catalog bytes. Reject malformed records as `catalog_cache_invalid` and re-run URL, signature, key, document, and SemVer checks every time a record is read.

- [ ] **Step 4: Implement `get_catalog` in trust order**

  1. Load and revalidate cache, retaining a valid snapshot only as a candidate.
  2. Return it as `fresh` when it is inside the TTL and refresh was not forced.
  3. Discover the release, fetch fixed catalog/signature URLs, verify the raw signature, decode JSON, and call `validate_catalog_document` with the URL-derived version and verified key ID.
  4. Compare the new release version to the valid cache floor; reject downgrades.
  5. Atomically persist only the new verified record and return `fresh`.
  6. On `CatalogTransportError` only, return a valid candidate as `stale`; otherwise raise the trust/contract error without fallback.

- [ ] **Step 5: Run retrieval tests and inspect file mode**

  Run: `python -m pytest -q tests/test_module_catalog_client.py -k "cache or rollback or verified"`

  On POSIX, add an assertion that the cache mode is `0o600` after the atomic write.

- [ ] **Step 6: Commit catalog cache and rollback behavior**

  ```bash
  git add xkeen-ui/services/module_catalog_client.py tests/test_module_catalog_client.py
  git commit -m "feat(modules): cache verified catalog releases"
  ```

### Task 6: Stream and Verify Archive Bytes for Stage 8.3

**Files:**
- Modify: `xkeen-ui/services/module_catalog_client.py`
- Modify: `tests/test_module_catalog_client.py`

**Interface:**

```python
def download_verified_archive(
    self,
    snapshot: CatalogSnapshot,
    module_id: str,
    destination_dir: str | os.PathLike[str],
) -> Path: ...
```

- [ ] **Step 1: Write failing archive download tests**

  From a signed snapshot fixture, assert the client generates the immutable official archive URL from `snapshot.release_version` plus the trusted entry filename; streams a correct archive to `destination_dir`; returns a file whose exact size and SHA-256 match the entry; rejects oversized, truncated, and digest-mismatched payloads; and leaves no `.part` file after any failure. Include unknown module ID coverage.

- [ ] **Step 2: Run the focused archive tests and verify the missing method**

  Run: `python -m pytest -q tests/test_module_catalog_client.py -k archive`

- [ ] **Step 3: Implement bounded streaming with cleanup**

  Select the normalized entry from `snapshot.catalog["modules"]`; do not accept an arbitrary entry or caller URL. Create a unique temporary path inside `destination_dir`, stream no more than `entry["size"] + 1` bytes through SHA-256, then require exact size and lowercase digest equality. Replace the final target only after all checks pass. In `finally`, unlink the temporary path on every exception. Convert size/digest violations to `CatalogClientError` codes including `catalog_archive_checksum_mismatch`.

- [ ] **Step 4: Run client and package contract tests together**

  Run: `python -m pytest -q tests/test_module_catalog_client.py tests/test_module_package_contract.py`

- [ ] **Step 5: Commit verified download support**

  ```bash
  git add xkeen-ui/services/module_catalog_client.py tests/test_module_catalog_client.py
  git commit -m "feat(modules): stream verified module archives"
  ```

### Task 7: Update Stage 8.2 Contracts, Documentation, and Generated Inventories

**Files:**
- Modify: `scripts/generate_modular_panel_stage8_contract.py`
- Modify: `tests/test_modular_panel_stage8_contract.py`
- Regenerate: `docs/modular-panel-stage8-contract.json`
- Regenerate: `docs/modular-panel-stage8-contract.md`
- Modify: `README-modular-panel-plan.md`
- Modify: `docs/README.md`
- Regenerate: `docs/modular-panel-stage0-inventory.json`
- Regenerate: `docs/modular-panel-stage0-inventory.md`
- Regenerate: `xkeen-ui/module-sizes.json`

**Contract additions:**

```json
{
  "trust_client": {
    "algorithm": "Ed25519",
    "signature_asset": "catalog.json.sig",
    "discovery": "https://api.github.com/repos/umarcheh001/Xkeen-UI/releases/latest",
    "cache_ttl_seconds": 86400,
    "allowed_redirect_hosts": [
      "github.com",
      "objects.githubusercontent.com",
      "release-assets.githubusercontent.com"
    ],
    "stale_fallback": "transport failures only",
    "anti_rollback": "highest verified release version"
  }
}
```

- [ ] **Step 1: Write failing generated-contract and roadmap assertions**

  Extend `tests/test_modular_panel_stage8_contract.py` to require the trust-client section, signature asset in `release_assets`, `release-2026` key ID, cache TTL, redirect hosts, and tag-only signer language. Assert the human contract no longer says Ed25519 remains deferred. Assert the roadmap marks 8.2 closed only after its implementation references and tests exist.

- [ ] **Step 2: Run the focused contract test and confirm it fails on the old snapshot**

  Run: `python -m pytest -q tests/test_modular_panel_stage8_contract.py`

- [ ] **Step 3: Update generator, roadmap, and docs index**

  Preserve the historical Stage 8.0 section while adding an explicit Stage 8.2 trust-client section to the generated contract. Include the public trust behavior but never embed secret/private material in a document. Update the roadmap status/progress and 8.2 entry with the code boundary, CI signing behavior, tests, design, and this implementation plan. Index the active plan in `docs/README.md`.

- [ ] **Step 4: Regenerate committed snapshots**

  Run:

  ```bash
  python scripts/generate_modular_panel_inventory.py --root .
  python scripts/sync_module_sizes.py --root .
  python scripts/generate_modular_panel_stage8_contract.py --root .
  ```

- [ ] **Step 5: Verify generated data and documentation**

  Run:

  ```bash
  python -m pytest -q tests/test_modular_panel_stage0_inventory.py tests/test_module_registry.py tests/test_modular_panel_stage8_contract.py
  git diff --check
  ```

- [ ] **Step 6: Commit contracts and documentation**

  ```bash
  git add README-modular-panel-plan.md docs/README.md scripts/generate_modular_panel_stage8_contract.py tests/test_modular_panel_stage8_contract.py docs/modular-panel-stage8-contract.json docs/modular-panel-stage8-contract.md docs/modular-panel-stage0-inventory.json docs/modular-panel-stage0-inventory.md xkeen-ui/module-sizes.json
  git commit -m "docs(modules): close stage 8.2 catalog trust"
  ```

### Task 8: Full Verification, Secret Configuration, and Handoff

**Files:**
- No product-code edits expected.

- [ ] **Step 1: Run all focused Stage 8.2 suites**

  Run:

  ```bash
  python -m pytest -q \
    tests/test_module_package_contract.py \
    tests/test_module_catalog_trust.py \
    tests/test_modular_panel_catalog_signer.py \
    tests/test_module_catalog_client.py \
    tests/test_modular_panel_release_builder.py \
    tests/test_modular_panel_release_workflow.py \
    tests/test_modular_panel_stage8_contract.py
  ```

- [ ] **Step 2: Build a local unsigned release and prove signing is explicit**

  Run:

  ```bash
  python scripts/build_modular_panel_release.py --root . --output-dir dist/modular-panel-local --version 1.0.0 --source-date-epoch 1700000000 --source-commit test-commit
  test ! -e dist/modular-panel-local/catalog.json.sig
  ```

  Then run the signer against a temporary test key only; verify it adds the sidecar and metadata entry. Do not use the production private key in a local shell.

- [ ] **Step 3: Run the full Python suite**

  Run: `python -m pytest -q`

- [ ] **Step 4: Audit the release and working tree**

  Run:

  ```bash
  git diff --check
  git status --short
  git log --oneline -8
  ```

  Confirm no PEM private key, temporary release directory, test secret, or `.part` file is staged. Remove only generated local verification directories that are known to be untracked and created in this task.

- [ ] **Step 5: Configure the GitHub Actions secret and push the test branch**

  In repository Actions secrets, set `XKEEN_RELEASE_ED25519_PRIVATE_KEY` to the PEM created for `release-2026`. Push the completed commits to `codex/modular-panel-testing`. A branch push validates the unsigned path; a controlled `v*` tag in the repository is required to exercise the secret-backed signature/publication path.

- [ ] **Step 6: Wait for the exact pushed workflow result**

  Report the terminal GitHub Actions conclusion for the pushed SHA. Do not report a successful release-signing path until a tag workflow with the configured secret has completed successfully.
