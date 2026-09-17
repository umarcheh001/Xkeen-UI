"""Optional install.sh step: Happ keys come from a third-party repository, so only an explicit yes downloads them."""

from __future__ import annotations

import importlib.util
import io
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "xkeen-ui"
SCRIPT = APP_DIR / "scripts" / "install_happ_decryptor.py"
INSTALL_SH = APP_DIR / "install.sh"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from services.happ_decryptor.errors import HappDecryptorError  # noqa: E402


def _load():
    spec = importlib.util.spec_from_file_location("install_happ_decryptor_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class FakeStdin(io.StringIO):
    def __init__(self, text: str | None, tty: bool) -> None:
        super().__init__("" if text is None else text + "\n")
        self.tty = tty
        self.read_calls = 0

    def isatty(self) -> bool:
        return self.tty

    def readline(self, *args):
        self.read_calls += 1
        return super().readline(*args)


class Installer:
    def __init__(self, result=None, error: Exception | None = None) -> None:
        self.calls = 0
        self.result = result or {
            "engine": {"version": "happ-decrypt-universal v1.0.0 (abc1234)"},
            "keys": {"installed": ["crypt5-keys.json", "legacy_keys.json"],
                     "manifest": {"repo": "LeeeeT/happ-decryptor", "commit": "5a05cfe59f45", "source": "remote"}},
        }
        self.error = error

    def __call__(self):
        self.calls += 1
        if self.error:
            raise self.error
        return self.result


def _run(env, *, answer=None, tty=False, installer=None):
    installer = installer or Installer()
    stdin, out = FakeStdin(answer, tty), io.StringIO()
    code = _load().main([], env=env, stdin=stdin, out=out, installer=installer)
    return code, out.getvalue(), installer, stdin


def test_env_one_installs_without_asking():
    code, text, installer, stdin = _run({"XKEEN_HAPP_DECRYPTOR_INSTALL": "1"}, tty=True)
    assert (code, installer.calls, stdin.read_calls) == (0, 1, 0)
    assert "happ-decrypt-universal v1.0.0" in text


def test_env_zero_skips_without_asking():
    code, _text, installer, stdin = _run({"XKEEN_HAPP_DECRYPTOR_INSTALL": "0"}, answer="y", tty=True)
    assert (code, installer.calls, stdin.read_calls) == (0, 0, 0)


def test_without_terminal_nothing_is_downloaded():
    code, text, installer, _stdin = _run({}, tty=False)
    assert (code, installer.calls) == (0, 0)
    assert "XKEEN_HAPP_DECRYPTOR_INSTALL=1" in text


@pytest.mark.parametrize("answer", ["y", "Y", "yes", "д", "да", "ДА"])
def test_explicit_yes_installs(answer):
    code, text, installer, _stdin = _run({}, answer=answer, tty=True)
    assert (code, installer.calls) == (0, 1)
    assert "Компоненты загрузятся с GitHub." in text, "the question says that something is downloaded"


@pytest.mark.parametrize("answer", ["", "n", "no", "нет", "н"])
def test_default_and_no_skip(answer):
    code, _text, installer, _stdin = _run({}, answer=answer, tty=True)
    assert (code, installer.calls) == (0, 0)


def test_unrecognized_answer_skips():
    code, text, installer, _stdin = _run({}, answer="maybe", tty=True)
    assert (code, installer.calls) == (0, 0)
    assert "не распознан" in text


def test_expected_failure_prints_hint_and_never_fails_the_installer():
    error = HappDecryptorError("checksum_missing", "В релизе нет контрольной суммы движка Happ.")
    code, text, _installer, _stdin = _run({"XKEEN_HAPP_DECRYPTOR_INSTALL": "1"}, installer=Installer(error=error))
    assert code == 0
    assert "В релизе нет контрольной суммы движка Happ." in text


def test_unexpected_failure_never_fails_the_installer():
    code, text, _installer, _stdin = _run({"XKEEN_HAPP_DECRYPTOR_INSTALL": "1"}, installer=Installer(error=OSError("boom")))
    assert code == 0
    assert "не удалось" in text.lower()


def test_install_sh_runs_the_step_after_copying_panel_files():
    text = INSTALL_SH.read_text(encoding="utf-8")
    copy = text.index("Копирую файлы панели")
    step = text.index("scripts/install_happ_decryptor.py")
    assert copy < step
    line = next(l for l in text.splitlines() if "scripts/install_happ_decryptor.py" in l and "PYTHON_BIN" in l)
    assert '"$UI_DIR/scripts/install_happ_decryptor.py"' in line, "the copied script finds the panel's bin/ next to it"
    assert line.rstrip().endswith("|| true")
