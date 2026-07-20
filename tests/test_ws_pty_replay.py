from services.ws_pty import _pty_replay_cursor


def test_reused_pty_session_resumes_after_last_rendered_sequence():
    assert _pty_replay_cursor(42, reused=True) == 42


def test_fresh_pty_session_replays_from_start_even_with_stale_client_cursor():
    assert _pty_replay_cursor(42, reused=False) == 0


def test_pty_replay_cursor_never_becomes_negative():
    assert _pty_replay_cursor(-7, reused=True) == 0
