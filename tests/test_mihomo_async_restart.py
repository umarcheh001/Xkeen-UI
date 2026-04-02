from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _read(rel_path: str) -> str:
    return (ROOT / rel_path).read_text(encoding="utf-8")


def test_mihomo_async_restart_flow_persists_full_restart_log():
    panel_src = _read("xkeen-ui/static/js/features/mihomo_panel.js")
    route_src = _read("xkeen-ui/routes/mihomo.py")
    jobs_src = _read("xkeen-ui/services/command_jobs.py")
    restart_log_src = _read("xkeen-ui/services/restart_log.py")

    assert "const url = restart ? '/api/mihomo-config?async=1' : '/api/mihomo-config';" in panel_src
    assert "const jobId = data.restart_job_id || data.job_id || data.restartJobId || null;" in panel_src
    assert 'async_q = request.args.get("async")' in route_src
    assert 'resp.update({"restart_queued": True, "restart_job_id": job.id})' in route_src
    assert "def write_restart_log(log_file: str, raw_text: str) -> None:" in restart_log_src
    assert "def _sync_restart_log(job: \"CommandJob\" | None) -> None:" in jobs_src
    assert "write_restart_log(_restart_log_file(), payload)" in jobs_src
