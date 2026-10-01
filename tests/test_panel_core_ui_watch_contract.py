"""Regression contract for the panel's runtime-core topology watcher."""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNTIME = (ROOT / "xkeen-ui/static/js/pages/panel.core_ui_watch.runtime.js").read_text(
    encoding="utf-8"
)


def test_first_successful_runtime_probe_primes_the_baseline_without_reload():
    """Static module topology must not cause a reload before a live baseline exists."""

    assert "let coreUiLiveTopologyInitialized = false;" in RUNTIME
    assert "function primeCoreUiTopologyFromLiveStatus(nextCores)" in RUNTIME

    prime_start = RUNTIME.index("function primeCoreUiTopologyFromLiveStatus(nextCores)")
    prime_end = RUNTIME.index("\nfunction scheduleCoreUiWatch", prime_start)
    prime = RUNTIME[prime_start:prime_end]
    assert "coreUiKnownDetectedCores = normalizeCoreList(nextCores);" in prime
    assert "coreUiKnownSignature = coreListSignature(coreUiKnownDetectedCores);" in prime
    assert "coreUiLiveTopologyInitialized = true;" in prime

    watcher_start = RUNTIME.index("async function checkCoreUiTopology(reason)")
    watcher = RUNTIME[watcher_start:]
    assert watcher.index("primeCoreUiTopologyFromLiveStatus(nextCores)") < watcher.index(
        "const prevCores = coreUiKnownDetectedCores.slice();"
    )
