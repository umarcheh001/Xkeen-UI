"""Helpers for working with Xray log configuration and log files."""

import os
import datetime
import re
from typing import Dict, List, Any


def load_xray_log_config(load_json, config_path: str, access_log: str, error_log: str) -> Dict[str, Any]:
    """Read or create Xray log config (01_log.json-like structure)."""
    default = {
        "log": {
            "access": access_log,
            "error": error_log,
            "loglevel": "none",
        }
    }
    cfg = load_json(config_path, default=default) or {}
    if not isinstance(cfg, dict):
        cfg = {}
    log_cfg = cfg.get("log")
    if not isinstance(log_cfg, dict):
        log_cfg = {}
    log_cfg.setdefault("access", access_log)
    log_cfg.setdefault("error", error_log)
    log_cfg.setdefault("loglevel", "none")
    cfg["log"] = log_cfg
    return cfg


def tail_lines(path: str, max_lines: int = 800, cache: Dict[str, Dict[str, Any]] | None = None) -> List[str]:
    """Return last max_lines lines from file with simple caching.

    If cache is provided, it should be a dict mapping path -> {"size","mtime","lines"}.
    """
    try:
        st = os.stat(path)
    except (FileNotFoundError, OSError):
        return []

    if cache is not None:
        info = cache.get(path)
        if info and info.get("size") == st.st_size and info.get("mtime") == st.st_mtime:
            lines = info.get("lines", [])
        else:
            try:
                with open(path, "r") as f:
                    lines = f.readlines()
            except (FileNotFoundError, OSError):
                return []
            cache[path] = {"size": st.st_size, "mtime": st.st_mtime, "lines": lines}
    else:
        try:
            with open(path, "r") as f:
                lines = f.readlines()
        except (FileNotFoundError, OSError):
            return []

    if max_lines and len(lines) > max_lines:
        return lines[-max_lines:]
    return lines


def adjust_log_timezone(lines: List[str], offset_hours: int) -> List[str]:
    """Shift timestamps in Xray/Mihomo logs by offset_hours hours."""

    if not offset_hours:
        return lines

    delta = datetime.timedelta(hours=offset_hours)

    xray_ts_re = re.compile(r"(\d{4})/(\d{2})/(\d{2}) (\d{2}):(\d{2}):(\d{2})")
    mihomo_ts_re = re.compile(r'time="(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)"')

    adjusted: List[str] = []

    for line in lines:
        def _repl_xray(m):
            try:
                dt = datetime.datetime(
                    int(m.group(1)),
                    int(m.group(2)),
                    int(m.group(3)),
                    int(m.group(4)),
                    int(m.group(5)),
                    int(m.group(6)),
                )
            except ValueError:
                return m.group(0)
            dt = dt + delta
            return dt.strftime("%Y/%m/%d %H:%M:%S")

        def _repl_mihomo(m):
            raw_ts = m.group(1)
            try:
                dt = datetime.datetime.fromisoformat(raw_ts.replace("Z", "+00:00"))
            except ValueError:
                return m.group(0)
            dt = dt + delta
            iso = dt.isoformat()
            iso = iso.replace("+00:00", "Z")
            return f'time="{iso}"'

        s = xray_ts_re.sub(_repl_xray, line)
        s = mihomo_ts_re.sub(_repl_mihomo, s)
        adjusted.append(s)

    return adjusted
