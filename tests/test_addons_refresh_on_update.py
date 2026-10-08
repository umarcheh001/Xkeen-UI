"""Дополнения обновляются вместе с панелью — когда в релизе они другие.

Обновление из панели не трогало ни просмотрщик DAT-файлов, ни утилиту ссылок
подписок: обновить их можно было только установщиком. Теперь перед заменой
файлов панели установленное дополнение сверяется с релизом по контрольной
сумме — это один маленький файл. Совпало — ничего не скачивается; не совпало —
ставится версия из релиза. Узнать не удалось — дополнение остаётся как было:
обновление панели от дополнений не зависит.
"""

from __future__ import annotations

import hashlib
import io
import os
import struct
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "xkeen-ui"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from services.happ_decryptor import engine, service  # noqa: E402

LIB = APP_DIR / "scripts" / "provision_env.sh"
GEODAT_INSTALLER = APP_DIR / "scripts" / "install_xk_geodat.sh"
LINKS_INSTALLER = APP_DIR / "scripts" / "install_happ_decryptor.py"

BASE = "https://github.com/umarcheh001/Xkeen-UI/releases/download/v2.11.0/"
ARM64 = "happ-decrypt-universal-linux-arm64"


def _elf() -> bytes:
    return b"\x7fELF\x02\x01\x01" + b"\0" * 11 + struct.pack("<H", 183) + os.urandom(256)


def _sums(**entries: bytes) -> bytes:
    return "".join(f"{hashlib.sha256(data).hexdigest()}  dist/{name}\n" for name, data in entries.items()).encode()


class Fetch:
    def __init__(self, by_url: dict[str, bytes]) -> None:
        self.by_url = by_url
        self.calls: list[str] = []

    def __call__(self, url: str, dest: str, max_bytes: int) -> int:
        self.calls.append(url)
        if url not in self.by_url:
            raise RuntimeError("http_404")
        Path(dest).write_bytes(self.by_url[url])
        return len(self.by_url[url])


def _run(argv, timeout):
    return (0, "happ-decrypt-universal v9.9.9 (abc1234)\n", "") if "-version" in argv else (2, "", "usage")


@pytest.fixture()
def installed(tmp_path):
    (tmp_path / "bin").mkdir()
    path = tmp_path / "bin" / "happ-decrypt-universal"
    path.write_bytes(_elf())
    return path


# --- движок утилиты ссылок ---------------------------------------------------------------


def test_an_engine_equal_to_the_release_is_not_downloaded(installed):
    fetch = Fetch({BASE + "SHA256SUMS": _sums(**{ARM64: installed.read_bytes()})})
    before = installed.read_bytes()

    result = engine.refresh_engine(str(installed), asset=ARM64, release_base=BASE, fetch=fetch, run=_run)

    assert result == {"changed": False, "reason": "same"}
    assert fetch.calls == [BASE + "SHA256SUMS"]
    assert installed.read_bytes() == before
    assert not Path(str(installed) + ".bak").exists()


def test_an_engine_that_differs_from_the_release_is_replaced(installed):
    newer = _elf()
    fetch = Fetch({BASE + "SHA256SUMS": _sums(**{ARM64: newer}), BASE + ARM64: newer})

    result = engine.refresh_engine(str(installed), asset=ARM64, release_base=BASE, fetch=fetch, run=_run)

    assert result["changed"] is True
    assert result["version"] == "happ-decrypt-universal v9.9.9 (abc1234)"
    assert installed.read_bytes() == newer


def test_an_engine_that_is_not_installed_is_not_brought(tmp_path):
    fetch = Fetch({})

    result = engine.refresh_engine(
        str(tmp_path / "bin" / "happ-decrypt-universal"), asset=ARM64, release_base=BASE, fetch=fetch, run=_run
    )

    # Дополнение ставит владелец; обновление панели его не навязывает.
    assert result == {"changed": False, "reason": "not_installed"}
    assert fetch.calls == []


def test_a_release_that_does_not_say_leaves_the_engine_alone(installed):
    before = installed.read_bytes()
    fetch = Fetch({})

    result = engine.refresh_engine(str(installed), asset=ARM64, release_base=BASE, fetch=fetch, run=_run)

    assert result == {"changed": False, "reason": "unknown"}
    assert installed.read_bytes() == before
    assert BASE + ARM64 not in fetch.calls


def test_the_service_refreshes_only_the_engine_never_the_keys(installed, monkeypatch):
    newer = _elf()
    fetch = Fetch({BASE + "SHA256SUMS": _sums(**{ARM64: newer}), BASE + ARM64: newer})
    monkeypatch.setattr(service, "update_keys", lambda *a, **k: pytest.fail("ключи берутся из стороннего источника"))

    result = service.refresh_engine(
        str(installed), release_base=BASE, fetch=fetch, run=_run, platform=lambda: {"asset": ARM64}
    )

    assert result["changed"] is True
    assert all("LeeeeT" not in url for url in fetch.calls)


# --- установщик утилиты ссылок как команда ---------------------------------------------------


def _links_installer():
    import importlib.util

    spec = importlib.util.spec_from_file_location("install_happ_decryptor_refresh", LINKS_INSTALLER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_refresh_command_reports_what_it_did_and_asks_nothing(installed):
    out = io.StringIO()
    seen = {}

    def refresher(bin_path=None, **kwargs):
        seen["called"] = True
        return {"changed": True, "version": "v9.9.9"}

    code = _links_installer().main(["--refresh"], env={}, stdin=None, out=out, refresher=refresher, bin_path=str(installed))

    assert code == 0
    assert seen == {"called": True}
    assert "v9.9.9" in out.getvalue()
    assert "y/N" not in out.getvalue()


def test_the_refresh_command_never_fails_the_update(installed):
    out = io.StringIO()

    def refresher(bin_path=None, **kwargs):
        raise RuntimeError("github is down")

    assert _links_installer().main(["--refresh"], env={}, stdin=None, out=out, refresher=refresher, bin_path=str(installed)) == 0
    assert "пропуск" in out.getvalue()


# --- просмотрщик DAT-файлов ----------------------------------------------------------------


def _geodat(
    tmp_path: Path,
    *,
    installed: bytes | None,
    sums: bytes | None,
    mode: str = "1",
    published: bytes = b"not a binary, the test stops before running it\n",
):
    dest = tmp_path / "bin" / "xk-geodat"
    dest.parent.mkdir(parents=True, exist_ok=True)
    if installed is not None:
        dest.write_bytes(installed)
    release = tmp_path / "release"
    release.mkdir(exist_ok=True)
    (release / "xk-geodat-linux-arm64").write_bytes(published)
    if sums is not None:
        (release / "SHA256SUMS").write_bytes(sums)
    base = release.as_uri() + "/"
    proc = subprocess.run(
        ["sh", GEODAT_INSTALLER.as_posix()],
        capture_output=True,
        timeout=120,
        env={
            **os.environ,
            "XKEEN_GEODAT_BIN": dest.as_posix(),
            "XKEEN_GEODAT_INSTALL": "1",
            "XKEEN_GEODAT_ONLY_IF_CHANGED": mode,
            "XKEEN_GEODAT_ASSET": "xk-geodat-linux-arm64",
            "XKEEN_GEODAT_URL": base + "xk-geodat-linux-arm64",
            "XKEEN_GEODAT_SHA256SUMS_URL": base + "SHA256SUMS",
        },
    )
    return proc.stdout.decode("utf-8", "replace") + proc.stderr.decode("utf-8", "replace"), dest


def _line(data: bytes) -> bytes:
    return f"{hashlib.sha256(data).hexdigest()}  dist/xk-geodat-linux-arm64\n".encode()


needs_fetcher = pytest.mark.skipif(
    not any((Path(folder) / name).exists() for folder in os.get_exec_path() for name in ("curl", "curl.exe", "wget")),
    reason="нужен curl или wget",
)


@needs_fetcher
def test_a_viewer_equal_to_the_release_is_not_downloaded(tmp_path):
    body = b"installed viewer\n"

    out, dest = _geodat(tmp_path, installed=body, sums=_line(body))

    assert "downloading" not in out, out
    assert dest.read_bytes() == body


@needs_fetcher
def test_a_viewer_that_differs_from_the_release_is_fetched(tmp_path):
    body = b"installed viewer\n"

    out, dest = _geodat(tmp_path, installed=body, sums=_line(b"another build\n"))

    # Дальше скачанное проверяется как обычно; подставной файл проверку не
    # проходит, и прежний просмотрщик остаётся на месте.
    assert "downloading" in out, out
    assert dest.read_bytes() == body


@needs_fetcher
def test_a_release_that_does_not_say_leaves_the_viewer_alone(tmp_path):
    body = b"installed viewer\n"

    out, dest = _geodat(tmp_path, installed=body, sums=None)

    assert "downloading" not in out, out
    assert dest.read_bytes() == body


@needs_fetcher
def test_an_ordinary_install_still_downloads_without_comparing(tmp_path):
    out, _dest = _geodat(tmp_path, installed=b"installed viewer\n", sums=_line(b"installed viewer\n"), mode="")

    assert "downloading" in out, out


@needs_fetcher
def test_a_download_is_held_to_the_checksum_the_release_publishes(tmp_path):
    # Строки в списке сумм релиза выглядят как «<сумма>  dist/<имя>». Прежний
    # образец такую строку не находил, и файл ставился без сверки.
    published = b"\x7fELF" + b"pretends to be a binary"

    out, dest = _geodat(tmp_path, installed=None, sums=_line(b"what the release really built"), mode="", published=published)

    assert "SHA256 mismatch" in out, out
    assert not dest.exists()


# --- общий скрипт: кого и чем обновлять -------------------------------------------------------


FAKE_GEODAT = """#!/bin/sh
# XKEEN_GEODAT_ONLY_IF_CHANGED
echo "geodat only_if_changed=${XKEEN_GEODAT_ONLY_IF_CHANGED:-} install=${XKEEN_GEODAT_INSTALL:-} tag=${XKEEN_GEODAT_TAG:-}" >> "$FAKE_TRACE"
"""
FAKE_LINKS = """#!/bin/sh
# stands in for install_happ_decryptor.py: --refresh
echo "links $* base=${XKEEN_HAPP_DECRYPTOR_RELEASE_URL:-}" >> "$FAKE_TRACE"
"""


def _addons(tmp_path: Path, *, modules, have=("xk-geodat", "happ-decrypt-universal"), target="2.11.0", old_scripts=False):
    ui = tmp_path / "xkeen-ui"
    (ui / "scripts").mkdir(parents=True)
    (ui / "bin").mkdir()
    for name in have:
        (ui / "bin" / name).write_bytes(b"installed\n")
        os.chmod(ui / "bin" / name, 0o755)
    geodat = '#!/bin/sh\necho "geodat of an older panel" >> "$FAKE_TRACE"\n' if old_scripts else FAKE_GEODAT
    links = '#!/bin/sh\necho "links of an older panel" >> "$FAKE_TRACE"\n' if old_scripts else FAKE_LINKS
    (ui / "scripts" / "install_xk_geodat.sh").write_bytes(geodat.encode("utf-8"))
    (ui / "scripts" / "install_happ_decryptor.py").write_bytes(links.encode("utf-8"))
    (ui / "install-profile.json").write_text(
        '{"schema_version": 1, "profile": "custom", "module_ids": [%s], "editor_variant": "light"}'
        % ", ".join(f'"{module}"' for module in modules),
        encoding="utf-8",
    )
    trace = tmp_path / "trace.txt"
    script = tmp_path / "call.sh"
    script.write_bytes(
        "\n".join(
            [
                "set -e",
                f'UI_DIR="{ui.as_posix()}"',
                # Подставной «python»: запускает переданный сценарий оболочкой.
                'PYTHON_BIN="sh"',
                f'. "{LIB.as_posix()}"',
                'PROVISION_MODULES="$(provision_installed_modules)"',
                "provision_addons",
                'echo "went on"',
                "",
            ]
        ).encode("utf-8")
    )
    env = {**os.environ, "FAKE_TRACE": trace.as_posix(), "TMPDIR": tmp_path.as_posix()}
    env.pop("XKEEN_UI_TARGET_VERSION", None)
    if target:
        env["XKEEN_UI_TARGET_VERSION"] = target
    proc = subprocess.run(["sh", script.as_posix()], capture_output=True, text=True, encoding="utf-8", env=env, timeout=120)
    assert "went on" in proc.stdout, proc.stdout + proc.stderr
    return trace.read_text(encoding="utf-8").splitlines() if trace.exists() else []


ALL = ("core", "engine.xray", "integration.happ")


def test_installed_addons_are_checked_against_the_release_being_installed(tmp_path):
    calls = _addons(tmp_path, modules=ALL)

    assert "geodat only_if_changed=1 install=1 tag=v2.11.0" in calls
    links = [line for line in calls if line.startswith("links ")]
    assert len(links) == 1 and "--refresh" in links[0]
    assert links[0].endswith("base=https://github.com/umarcheh001/Xkeen-UI/releases/download/v2.11.0/")


def test_an_addon_that_is_not_installed_is_not_brought_by_the_update(tmp_path):
    assert _addons(tmp_path, modules=ALL, have=()) == []


def test_an_addon_of_a_module_that_is_not_installed_is_left_alone(tmp_path):
    calls = _addons(tmp_path, modules=("core",))

    assert calls == []


def test_installers_that_cannot_compare_are_not_run(tmp_path):
    # Установщик прежней версии сравнивать не умеет и скачал бы дополнение
    # заново при каждом обновлении панели.
    assert _addons(tmp_path, modules=ALL, old_scripts=True) == []


def test_the_prepare_step_refreshes_the_addons():
    shared = LIB.read_text(encoding="utf-8")
    prepare = shared[shared.index("provision_cmd_prepare() {"):]
    prepare = prepare[: prepare.index("\n}\n")]

    assert "provision_addons" in prepare
