from __future__ import annotations

import builtins

from services import xray_logs


class _ReadCounter:
    def __init__(self, stream, counter):
        self._stream = stream
        self._counter = counter

    def __enter__(self):
        self._stream.__enter__()
        return self

    def __exit__(self, *args):
        return self._stream.__exit__(*args)

    def __getattr__(self, name):
        return getattr(self._stream, name)

    def read(self, size=-1):
        data = self._stream.read(size)
        self._counter["bytes"] += len(data)
        return data


def test_tail_reads_and_caches_only_a_bounded_suffix(tmp_path, monkeypatch):
    path = tmp_path / "large.log"
    path.write_bytes(b"".join(f"line-{index:06d} ".encode() + (b"x" * 1000) + b"\n" for index in range(5000)))
    counter = {"bytes": 0}

    def tracking_open(*args, **kwargs):
        return _ReadCounter(builtins.open(*args, **kwargs), counter)

    monkeypatch.setattr(xray_logs, "open", tracking_open, raising=False)
    cache = {}

    lines = xray_logs.tail_lines(str(path), max_lines=20, cache=cache)

    assert len(lines) == 20
    assert lines[0].startswith("line-004980")
    assert lines[-1].startswith("line-004999")
    assert counter["bytes"] <= 256 * 1024
    assert len(cache[str(path)]["lines"]) == 20

    counter["bytes"] = 0
    assert xray_logs.tail_lines(str(path), max_lines=10, cache=cache) == lines[-10:]
    assert counter["bytes"] == 0


def test_tail_cache_reloads_when_a_larger_window_is_requested(tmp_path, monkeypatch):
    path = tmp_path / "xray.log"
    path.write_text("".join(f"{index}\n" for index in range(1000)), encoding="utf-8")
    counter = {"bytes": 0}

    def tracking_open(*args, **kwargs):
        return _ReadCounter(builtins.open(*args, **kwargs), counter)

    monkeypatch.setattr(xray_logs, "open", tracking_open, raising=False)
    cache = {}

    assert len(xray_logs.tail_lines(str(path), max_lines=10, cache=cache)) == 10
    counter["bytes"] = 0
    assert len(xray_logs.tail_lines(str(path), max_lines=50, cache=cache)) == 50
    assert counter["bytes"] > 0
    assert cache[str(path)]["max_lines"] == 50
