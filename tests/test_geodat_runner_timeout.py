from __future__ import annotations

import subprocess

from services.geodat import runner


def test_geodat_retry_uses_one_total_timeout_budget(monkeypatch):
    now = [0.0]
    timeouts: list[float] = []

    monkeypatch.setattr(runner.time, "monotonic", lambda: now[0])

    def fake_run(_argv, **kwargs):
        timeouts.append(float(kwargs["timeout"]))
        now[0] += 4.2
        if len(timeouts) == 1:
            return subprocess.CompletedProcess(
                _argv,
                1,
                "",
                "set ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH=go1.25",
            )
        return subprocess.CompletedProcess(_argv, 0, '{"items":[]}', "")

    monkeypatch.setattr(runner.subprocess, "run", fake_run)

    assert runner._run_xk_geodat_json(["xk-geodat", "dump"], timeout_s=5) == {"items": []}
    assert timeouts == [5.0, 0.8]
