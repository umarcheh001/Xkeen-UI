from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "xkeen-ui" / "scripts" / "install_xk_geodat.sh"


def test_install_xk_geodat_prompt_only_accepts_explicit_yes() -> None:
    text = SCRIPT.read_text(encoding="utf-8")

    assert 'normalize_install_answer()' in text
    assert 'case "$ans_norm" in' in text
    assert '""|y|yes) INSTALL="1" ;;' in text
    assert 'n|no)     INSTALL="0" ;;' in text
    assert 'INSTALL="0"' in text
    assert 'ответ не распознан — пропуск' in text
    assert '*)         INSTALL="1" ;;' not in text
