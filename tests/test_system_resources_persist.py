from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "xkeen-ui"))

from services.system_resources_history import persist  # noqa: E402
from services.system_resources_history.persist import FORMAT_VERSION, load_history, save_history  # noqa: E402
from services.system_resources_history.store import HistoryStore  # noqa: E402

T0 = 1_000_000 * 1800


def make_store(metrics=("cpu",), n=40):
    s = HistoryStore(metrics)
    for k in range(n):
        s.add(T0 + k * 5, {m: 10.0 + k for m in metrics})
    return s


def test_roundtrip(tmp_path):
    p = str(tmp_path / "h.json")
    s = make_store()
    save_history(p, s, [], now=T0 + 500)
    got = load_history([p], ("cpu",))
    assert got is not None
    store, events, saved_at, _meta = got
    assert saved_at == T0 + 500
    assert events == []
    a = s.columns("15m", T0 + 200)["metrics"]["cpu"]
    b = store.columns("15m", T0 + 200)["metrics"]["cpu"]
    assert a["avg"] == b["avg"]
    assert a["max"] == b["max"]
    data = json.loads(Path(p).read_text(encoding="utf-8"))
    assert data["version"] == FORMAT_VERSION
    assert data["metrics"] == ["cpu"]


def test_numbers_rounded(tmp_path):
    p = str(tmp_path / "h.json")
    s = HistoryStore(("cpu",))
    s.add(T0, {"cpu": 12.3456789})
    save_history(p, s, [], now=T0 + 1)
    text = Path(p).read_text(encoding="utf-8")
    assert "12.3456" not in text
    assert "12.3" in text


def test_picks_freshest_of_tmp_and_flash(tmp_path):
    tmp = str(tmp_path / "tmp" / "h.json")
    flash = str(tmp_path / "flash" / "h.json")
    save_history(flash, make_store(n=10), [{"k": "old"}], now=1000)
    save_history(tmp, make_store(n=20), [{"k": "new"}], now=2000)
    store, events, saved_at, _meta = load_history([flash, tmp], ("cpu",))
    assert saved_at == 2000
    assert events == [{"k": "new"}]
    store, events, saved_at, _meta = load_history([tmp, flash], ("cpu",))
    assert saved_at == 2000


def test_missing_files_ok_and_all_missing_none(tmp_path):
    flash = str(tmp_path / "flash.json")
    assert load_history([str(tmp_path / "no.json"), flash], ("cpu",)) is None
    save_history(flash, make_store(), [], now=5)
    got = load_history([str(tmp_path / "no.json"), flash], ("cpu",))
    assert got is not None and got[2] == 5


def test_version_mismatch_returns_none(tmp_path):
    p = tmp_path / "h.json"
    save_history(str(p), make_store(), [], now=1)
    data = json.loads(p.read_text(encoding="utf-8"))
    data["version"] = 99
    p.write_text(json.dumps(data), encoding="utf-8")
    assert load_history([str(p)], ("cpu",)) is None


def test_metric_set_change_keeps_common_metrics(tmp_path):
    p = str(tmp_path / "h.json")
    s = make_store(("cpu", "rate_up:ISP"))
    save_history(p, s, [], now=T0 + 500)
    store, _events, _at, _meta = load_history([p], ("cpu", "rate_up:UsbQmi0"))
    assert store.metrics == ("cpu", "rate_up:UsbQmi0")
    cols = store.columns("15m", T0 + 200)["metrics"]
    assert "rate_up:ISP" not in cols
    assert any(v is not None for v in cols["cpu"]["avg"])
    assert all(v is None for v in cols["rate_up:UsbQmi0"]["avg"])
    # the survivor keeps working
    store.add(T0 + 600, {"cpu": 5.0, "rate_up:UsbQmi0": 7.0})


def test_tier_steps_mismatch_returns_none(tmp_path):
    p = tmp_path / "h.json"
    save_history(str(p), make_store(), [], now=1)
    data = json.loads(p.read_text(encoding="utf-8"))
    data["tiers"]["fresh"][0] = 20
    p.write_text(json.dumps(data), encoding="utf-8")
    assert load_history([str(p)], ("cpu",)) is None


def test_tier_size_mismatch_in_store_returns_none(tmp_path):
    p = tmp_path / "h.json"
    save_history(str(p), make_store(), [], now=1)
    data = json.loads(p.read_text(encoding="utf-8"))
    data["store"]["tiers"]["day"]["starts"] = data["store"]["tiers"]["day"]["starts"][:10]
    p.write_text(json.dumps(data), encoding="utf-8")
    assert load_history([str(p)], ("cpu",)) is None


def test_truncated_json_returns_none(tmp_path):
    p = tmp_path / "h.json"
    save_history(str(p), make_store(), [], now=1)
    raw = p.read_text(encoding="utf-8")
    p.write_text(raw[: len(raw) // 2], encoding="utf-8")
    assert load_history([str(p)], ("cpu",)) is None


def test_bad_shapes_return_none(tmp_path):
    for body in ("[]", "null", '{"version": 1}', '{"version": 1, "saved_at": "x"}', ""):
        p = tmp_path / "h.json"
        p.write_text(body, encoding="utf-8")
        assert load_history([str(p)], ("cpu",)) is None


def test_corrupt_copy_does_not_hide_good_copy(tmp_path):
    good = str(tmp_path / "good.json")
    bad = tmp_path / "bad.json"
    save_history(good, make_store(), [], now=10)
    bad.write_text("{oops", encoding="utf-8")
    got = load_history([str(bad), good], ("cpu",))
    assert got is not None and got[2] == 10


def test_events_restored(tmp_path):
    p = tmp_path / "h.json"
    ev = [{"kind": "cpu", "start": 1, "end": None}, {"kind": "mem", "start": 2}]
    save_history(str(p), make_store(), ev, now=3)
    assert load_history([str(p)], ("cpu",))[1] == ev
    data = json.loads(p.read_text(encoding="utf-8"))
    data["events"] = [{"a": 1}, 5, "x", None, {"b": 2}]
    p.write_text(json.dumps(data), encoding="utf-8")
    assert load_history([str(p)], ("cpu",))[1] == [{"a": 1}, {"b": 2}]
    data["events"] = "nope"
    p.write_text(json.dumps(data), encoding="utf-8")
    assert load_history([str(p)], ("cpu",))[1] == []


def test_uses_atomic_helper(tmp_path, monkeypatch):
    calls = []

    def fake(path, obj, *args, **kwargs):
        calls.append((path, kwargs))

    monkeypatch.setattr(persist, "_atomic_write_json", fake)
    save_history(str(tmp_path / "h.json"), make_store(), [], now=1)
    assert len(calls) == 1
    assert calls[0][1].get("indent") is None


def test_with_metrics_helper():
    s = make_store(("a", "b"))
    r = s.with_metrics(("b", "c"))
    assert r.metrics == ("b", "c")
    cols = r.columns("15m", T0 + 200)["metrics"]
    assert any(v is not None for v in cols["b"]["avg"])
    assert all(v is None for v in cols["c"]["avg"])


def test_meta_roundtrip_and_tolerance(tmp_path):
    p = tmp_path / "h.json"
    save_history(str(p), make_store(), [], now=3, meta={"uptime_s": 1234.5})
    assert load_history([str(p)], ("cpu",))[3] == {"uptime_s": 1234.5}
    data = json.loads(p.read_text(encoding="utf-8"))
    for bad in ("x", [1], 5, None):
        data["meta"] = bad
        p.write_text(json.dumps(data), encoding="utf-8")
        assert load_history([str(p)], ("cpu",))[3] == {}
    del data["meta"]
    p.write_text(json.dumps(data), encoding="utf-8")
    assert load_history([str(p)], ("cpu",))[3] == {}


def test_metrics_none_keeps_saved_set(tmp_path):
    p = str(tmp_path / "h.json")
    save_history(p, make_store(("cpu", "rate_up:ISP")), [], now=T0 + 500)
    assert load_history([p], None)[0].metrics == ("cpu", "rate_up:ISP")
