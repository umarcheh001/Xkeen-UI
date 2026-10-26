from types import SimpleNamespace

from services import blocking


def test_run_blocking_calls_directly_without_gevent(monkeypatch):
    monkeypatch.setattr(blocking, "_threading_patched", lambda: False)

    assert blocking.run_blocking(lambda a, b=0: a + b, 2, b=3) == 5


def test_run_blocking_uses_hub_threadpool_under_gevent(monkeypatch):
    calls = []

    def apply(fn, args, kwargs):
        calls.append((fn, args, kwargs))
        return "pooled"

    hub = SimpleNamespace(threadpool=SimpleNamespace(apply=apply))
    monkeypatch.setattr(blocking, "_threading_patched", lambda: True)
    monkeypatch.setattr(blocking, "_hub", lambda: hub)

    assert blocking.run_blocking(len, "abc") == "pooled"
    assert calls == [(len, ("abc",), {})]
