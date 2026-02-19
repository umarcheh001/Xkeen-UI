"""Optional YAML validation helpers for Mihomo.

PyYAML is optional on the router. If it's not available, validation is
skipped and configs are treated as syntactically OK.
"""

from __future__ import annotations

from typing import Tuple

try:
    import yaml as _yaml
except Exception:  # pragma: no cover - depends on runtime environment
    _yaml = None


def validate_yaml_syntax(cfg: str) -> Tuple[bool, str]:
    """Fast YAML syntax check.

    Returns (ok, error_message). If PyYAML is not installed, returns (True, "").
    """

    if _yaml is None:
        return True, ""
    try:
        _yaml.safe_load(cfg)
        return True, ""
    except Exception as e:  # pragma: no cover - PyYAML parser details
        return False, str(e)
