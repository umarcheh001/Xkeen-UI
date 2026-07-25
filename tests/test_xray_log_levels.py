from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def run_xray_log_level_probe(script: str):
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        check=True,
        text=True,
        capture_output=True,
    )
    return json.loads(result.stdout)


def test_xray_log_level_filter_prioritizes_failure_content_over_info_wrapper():
    data = run_xray_log_level_probe(
        r"""
        import {
          detectXrayLogLineLevel,
          shouldKeepXrayLogLineForLevel,
        } from './xkeen-ui/static/js/features/xray_log_line_class.js';

        const failedOutbound = '2026/07/25 14:48:01 [Info] app/proxyman/outbound: failed to process outbound traffic';
        const streamError = '2026/07/25 14:47:55 [Info] proxy/vless/outbound: failed to transfer response payload > stream ERROR: INTERNAL_ERROR';
        const warning = '2026/07/25 14:48:10 [Warning] transport/internet: retrying connection';
        const info = '2026/07/25 14:48:11 [Info] transport/internet/tcp: dialing TCP';
        const debug = '2026/07/25 14:48:12 [Debug] app/dispatcher: route lookup';
        const unclassified = 'continuation without a level marker';

        console.log(JSON.stringify({
          levels: {
            failedOutbound: detectXrayLogLineLevel(failedOutbound),
            streamError: detectXrayLogLineLevel(streamError),
            warning: detectXrayLogLineLevel(warning),
            info: detectXrayLogLineLevel(info),
            debug: detectXrayLogLineLevel(debug),
            unclassified: detectXrayLogLineLevel(unclassified),
          },
          keep: {
            failedAtWarning: shouldKeepXrayLogLineForLevel(failedOutbound, 'warning'),
            failedAtError: shouldKeepXrayLogLineForLevel(failedOutbound, 'error'),
            streamAtError: shouldKeepXrayLogLineForLevel(streamError, 'error'),
            warningAtWarning: shouldKeepXrayLogLineForLevel(warning, 'warning'),
            warningAtError: shouldKeepXrayLogLineForLevel(warning, 'error'),
            infoAtWarning: shouldKeepXrayLogLineForLevel(info, 'warning'),
            infoAtInfo: shouldKeepXrayLogLineForLevel(info, 'info'),
            debugAtInfo: shouldKeepXrayLogLineForLevel(debug, 'info'),
            unknownAtError: shouldKeepXrayLogLineForLevel(unclassified, 'error'),
          },
        }));
        """
    )

    assert data["levels"] == {
        "failedOutbound": "error",
        "streamError": "error",
        "warning": "warning",
        "info": "info",
        "debug": "debug",
        "unclassified": "",
    }
    assert data["keep"] == {
        "failedAtWarning": True,
        "failedAtError": True,
        "streamAtError": True,
        "warningAtWarning": True,
        "warningAtError": False,
        "infoAtWarning": False,
        "infoAtInfo": True,
        "debugAtInfo": False,
        "unknownAtError": True,
    }


def test_xray_logs_view_uses_shared_semantic_level_filter():
    script = (ROOT / "xkeen-ui/static/js/features/xray_logs.js").read_text(encoding="utf-8")

    assert "shouldKeepXrayLogLineForLevel" in script
    assert "shouldKeepLineForLevel" not in script
    assert "detectXrayLevel" not in script
