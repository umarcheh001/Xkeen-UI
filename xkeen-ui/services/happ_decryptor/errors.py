from __future__ import annotations


class HappDecryptorError(Exception):
    """An expected failure with a stable ``code`` and a short Russian ``hint`` for the UI."""

    def __init__(self, code: str, hint: str) -> None:
        super().__init__(f"{code}: {hint}")
        self.code = code
        self.hint = hint
