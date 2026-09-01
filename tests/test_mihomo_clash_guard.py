from __future__ import annotations

from services.mihomo_clash_guard import (
    MIHOMO_CLASH_ACTION_POLICIES,
    MihomoClashActionGuard,
    MihomoClashActionPolicy,
)


def test_default_delay_policy_protects_low_power_router_batches():
    policy = MIHOMO_CLASH_ACTION_POLICIES["delay"]
    assert policy.max_global_concurrent == 5
    assert policy.max_subject_concurrent == 5


def test_delay_policy_window_covers_a_full_large_group_run():
    # Five parallel workers without pauses finish a 200+ node group well above
    # the old 120-call window, which left the tail of the run unmeasured.
    policy = MIHOMO_CLASH_ACTION_POLICIES["delay"]
    assert policy.max_calls_per_window == 600
    assert policy.window_seconds == 60.0


def test_action_guard_limits_same_subject_concurrency_and_releases_lease():
    guard = MihomoClashActionGuard()
    lease, rejected = guard.try_acquire("proxy-select", "operator")
    assert lease is not None
    assert rejected is None

    second, rejected = guard.try_acquire("proxy-select", "operator")
    assert second is None
    assert rejected is not None
    assert rejected.code == "action_busy"

    lease.release()
    third, rejected = guard.try_acquire("proxy-select", "operator")
    assert third is not None
    assert rejected is None
    third.release()


def test_delay_guard_allows_only_one_zashboard_sized_batch_at_a_time():
    guard = MihomoClashActionGuard()
    leases = []
    for _ in range(5):
        lease, rejected = guard.try_acquire("delay", "operator")
        assert lease is not None
        assert rejected is None
        leases.append(lease)

    overflow, rejected = guard.try_acquire("delay", "operator")
    assert overflow is None
    assert rejected is not None
    assert rejected.code == "action_busy"
    for lease in leases:
        lease.release()


def test_action_guard_enforces_global_concurrency_across_subjects():
    policy = MihomoClashActionPolicy(2, 1, 10, 60)
    guard = MihomoClashActionGuard(policies={"delay": policy})
    first, _ = guard.try_acquire("delay", "one")
    second, _ = guard.try_acquire("delay", "two")
    third, rejected = guard.try_acquire("delay", "three")

    assert first is not None
    assert second is not None
    assert third is None
    assert rejected is not None
    assert rejected.code == "action_busy"
    first.release()
    second.release()


def test_action_guard_rate_window_is_deterministic_and_recovers():
    current = [100.0]
    policy = MihomoClashActionPolicy(1, 1, 2, 10)
    guard = MihomoClashActionGuard(
        policies={"delay": policy},
        clock=lambda: current[0],
    )

    for _ in range(2):
        lease, rejected = guard.try_acquire("delay", "operator")
        assert lease is not None
        assert rejected is None
        lease.release()

    lease, rejected = guard.try_acquire("delay", "operator")
    assert lease is None
    assert rejected is not None
    assert rejected.code == "action_rate_limited"
    assert rejected.retry_after_seconds == 10

    current[0] = 111.0
    lease, rejected = guard.try_acquire("delay", "operator")
    assert lease is not None
    assert rejected is None
    lease.release()


def test_action_guard_fails_closed_for_unknown_action():
    lease, rejected = MihomoClashActionGuard().try_acquire("generic-relay", "operator")
    assert lease is None
    assert rejected is not None
    assert rejected.code == "action_not_allowed"
