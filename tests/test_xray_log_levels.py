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


def test_xray_log_level_filter_uses_xray_marker_before_payload_words():
    data = run_xray_log_level_probe(
        r"""
        import {
          detectXrayLogLineLevel,
          getXrayLogLineClass,
          shouldKeepXrayLogLineForLevel,
        } from './xkeen-ui/static/js/features/xray_log_line_class.js';

        const infoFailure = '2026/07/25 14:48:01 [Info] app/proxyman/outbound: failed to process outbound traffic';
        const infoStreamError = '2026/07/25 14:47:55 [Info] proxy/vless/outbound: failed to transfer response payload > stream ERROR: INTERNAL_ERROR';
        const warningPayload = '2026/07/25 14:48:10 [Warning] transport/internet: failed to retry stream ERROR';
        const error = '2026/07/25 14:48:10 [Error] transport/internet: failed to connect';
        const info = '2026/07/25 14:48:11 [Info] transport/internet/tcp: dialing TCP';
        const debug = '2026/07/25 14:48:12 [Debug] app/dispatcher: route lookup';
        const unclassified = 'continuation without a level marker';

        const samples = { infoFailure, infoStreamError, warningPayload, error, info, debug };
        const thresholds = ['debug', 'info', 'warning', 'error'];
        console.log(JSON.stringify({
          levels: {
            infoFailure: detectXrayLogLineLevel(infoFailure),
            infoStreamError: detectXrayLogLineLevel(infoStreamError),
            warningPayload: detectXrayLogLineLevel(warningPayload),
            error: detectXrayLogLineLevel(error),
            info: detectXrayLogLineLevel(info),
            debug: detectXrayLogLineLevel(debug),
            unclassified: detectXrayLogLineLevel(unclassified),
          },
          classes: {
            infoFailure: getXrayLogLineClass(infoFailure),
            infoStreamError: getXrayLogLineClass(infoStreamError),
            warningPayload: getXrayLogLineClass(warningPayload),
            error: getXrayLogLineClass(error),
          },
          keep: Object.fromEntries(thresholds.map((threshold) => [
            threshold,
            Object.fromEntries(Object.entries(samples).map(([name, line]) => [
              name,
              shouldKeepXrayLogLineForLevel(line, threshold),
            ])),
          ])),
        }));
        """
    )

    assert data["levels"] == {
        "infoFailure": "info",
        "infoStreamError": "info",
        "warningPayload": "warning",
        "error": "error",
        "info": "info",
        "debug": "debug",
        "unclassified": "",
    }
    assert data["classes"] == {
        "infoFailure": "log-line log-line-info",
        "infoStreamError": "log-line log-line-info",
        "warningPayload": "log-line log-line-warning",
        "error": "log-line log-line-error",
    }
    assert data["keep"] == {
        "debug": {
            "infoFailure": True,
            "infoStreamError": True,
            "warningPayload": True,
            "error": True,
            "info": True,
            "debug": True,
        },
        "info": {
            "infoFailure": True,
            "infoStreamError": True,
            "warningPayload": True,
            "error": True,
            "info": True,
            "debug": False,
        },
        "warning": {
            "infoFailure": False,
            "infoStreamError": False,
            "warningPayload": True,
            "error": True,
            "info": False,
            "debug": False,
        },
        "error": {
            "infoFailure": False,
            "infoStreamError": False,
            "warningPayload": False,
            "error": True,
            "info": False,
            "debug": False,
        },
    }


def test_xray_logs_view_uses_shared_semantic_level_filter():
    script = (ROOT / "xkeen-ui/static/js/features/xray_logs.js").read_text(encoding="utf-8")
    styles = (ROOT / "xkeen-ui/static/styles.css").read_text(encoding="utf-8")

    assert "shouldKeepXrayLogLineForLevel" in script
    assert "shouldKeepLineForLevel" not in script
    assert "detectXrayLevel" not in script

    # loglevel is a threshold for error.log only.  access.log must remain
    # visible as-is even when the same selector has a saved value.
    assert "const levelFilter = (isErrorFile && ALLOWED_LOGLEVELS.includes(selectedLevel)) ? selectedLevel : '';" in script
    assert "lvlSel.disabled = !isError;" in script
    assert "const cls = _isErrorFileName(_currentFile) ? getXrayLogLineClass(clean) : 'log-line';" in script

    # The live Xray viewer also sits inside .log-card.  Keep restart-card
    # colors scoped to restart-log-* so an Info line containing payload ERROR
    # is not painted red as a whole row.
    assert ".log-card .log-line-error" not in styles
    assert ".log-card .restart-log-line.log-line-error" in styles


def test_terminal_xray_level_control_is_error_log_only():
    script = (ROOT / "xkeen-ui/static/js/terminal/xray_tail.js").read_text(encoding="utf-8")
    template = (ROOT / "xkeen-ui/templates/panel.html").read_text(encoding="utf-8")

    assert "levelSel.disabled = !isError;" in script
    assert "preserveActiveLevel: kind === 'access'" in script
    assert '<option value="error">error</option>' in template
