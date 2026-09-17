"""Helpers for working with Xray log configuration and log files."""

import datetime
import os
import re
from typing import Dict, List, Any


_TAIL_MIN_BYTES = 256 * 1024
_TAIL_MAX_BYTES = 2 * 1024 * 1024
_TAIL_BYTES_PER_LINE = 1024


def _bounded_tail_bytes(path: str, *, max_lines: int, max_bytes: int) -> List[str]:
    """Read a bounded suffix without materializing the whole log file."""

    line_limit = max(1, int(max_lines or 1))
    byte_limit = max(16 * 1024, int(max_bytes or _TAIL_MIN_BYTES))
    chunks: List[bytes] = []
    buffered = 0
    newline_count = 0

    try:
        with open(path, "rb") as stream:
            stream.seek(0, os.SEEK_END)
            position = stream.tell()
            while position > 0 and buffered < byte_limit and newline_count <= line_limit:
                step = min(16 * 1024, position, byte_limit - buffered)
                if step <= 0:
                    break
                position -= step
                stream.seek(position, os.SEEK_SET)
                chunk = stream.read(step)
                chunks.append(chunk)
                buffered += len(chunk)
                newline_count += chunk.count(b"\n")
    except (FileNotFoundError, OSError):
        return []

    if not chunks:
        return []
    raw_lines = b"".join(reversed(chunks)).splitlines(True)
    return [line.decode("utf-8", "replace") for line in raw_lines[-line_limit:]]


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
    """Return a memory-bounded tail with optional metadata-aware caching.

    The old implementation used ``readlines()`` and cached the complete log,
    even when callers requested only a small tail.  Large access logs could
    therefore remain resident for the lifetime of the UI process.
    """
    line_limit = max(1, int(max_lines or 1))
    byte_limit = min(
        _TAIL_MAX_BYTES,
        max(_TAIL_MIN_BYTES, line_limit * _TAIL_BYTES_PER_LINE),
    )
    try:
        st = os.stat(path)
    except (FileNotFoundError, OSError):
        return []

    if cache is not None:
        info = cache.get(path)
        if (
            info
            and info.get("size") == st.st_size
            and info.get("mtime") == st.st_mtime
            and int(info.get("ino", 0) or 0) == int(getattr(st, "st_ino", 0) or 0)
            and int(info.get("max_lines", 0) or 0) >= line_limit
        ):
            lines = list(info.get("lines", []))[-line_limit:]
        else:
            lines = _bounded_tail_bytes(path, max_lines=line_limit, max_bytes=byte_limit)
            cache[path] = {
                "size": st.st_size,
                "mtime": st.st_mtime,
                "ino": int(getattr(st, "st_ino", 0) or 0),
                "max_lines": line_limit,
                "lines": lines,
            }
    else:
        lines = _bounded_tail_bytes(path, max_lines=line_limit, max_bytes=byte_limit)
    return lines



# ---------------------------------------------------------------------------
# Fast tail / incremental follow helpers (generic, used by DevTools)
# ---------------------------------------------------------------------------

def tail_lines_fast(path: str, max_lines: int = 800, max_bytes: int = 256 * 1024) -> List[str]:
    """Return last *max_lines* lines efficiently.

    Unlike tail_lines(), this avoids reading the whole file into memory.
    It reads from the end of the file in binary blocks.

    Returns decoded UTF-8 lines (with original line breaks when present).
    """
    try:
        os.stat(path)
    except (FileNotFoundError, OSError):
        return []

    return _bounded_tail_bytes(
        path,
        max_lines=max(1, int(max_lines or 800)),
        max_bytes=max_bytes,
    )


def read_new_lines(
    path: str,
    offset: int,
    *,
    carry: bytes = b"",
    max_bytes: int = 128 * 1024,
) -> tuple[List[str], int, bytes]:
    """Read and return complete lines starting from byte *offset*.

    This is meant for "follow"/incremental log streaming:
      * reads up to max_bytes from the file starting at offset
      * prepends optional carry (an unfinished last line from previous read)
      * returns only complete lines (keeping line endings)
      * returns updated offset and carry for the next call

    Returns: (lines, new_offset, new_carry)
    """
    try:
        st = os.stat(path)
    except (FileNotFoundError, OSError):
        return [], int(offset or 0), b""

    size = int(getattr(st, "st_size", 0) or 0)
    offset = int(offset or 0)
    if offset < 0:
        offset = 0
    if offset > size:
        offset = size

    max_bytes = max(4 * 1024, int(max_bytes or 128 * 1024))

    try:
        with open(path, "rb") as f:
            f.seek(offset, os.SEEK_SET)
            data = f.read(max_bytes)
            new_offset = f.tell()
    except (FileNotFoundError, OSError):
        return [], offset, b""

    buf = (carry or b"") + (data or b"")
    if not buf:
        return [], new_offset, b""

    parts = buf.splitlines(True)
    new_carry = b""

    if parts:
        last = parts[-1]
        if not last.endswith(b"\n") and not last.endswith(b"\r"):
            new_carry = last
            parts = parts[:-1]

    lines = [p.decode("utf-8", "replace") for p in parts]
    return lines, new_offset, new_carry



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
