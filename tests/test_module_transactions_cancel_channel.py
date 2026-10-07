"""Отмена операции доходит до исполнителя без номера его процесса.

Исполнитель сам слушает просьбу об отмене на локальном адресе и сам себя
прерывает. Сигнал по номеру процесса мог бы уйти чужому процессу, получившему
тот же номер, а защититься от этого умеет только ядро 5.3 и новее — на роутерах
оно старше, и отмена там не работала вовсе.
"""

from __future__ import annotations

import importlib.util
import os
import signal
import socket
import threading
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from services.module_transactions.cancel_channel import CancelListener, send_cancel
from services.module_transactions.journal import Journal
from services.module_transactions.launcher import request_cancel
from services.module_transactions.plan import build_plan
from services.module_transactions.state import read_status
from tests.support.module_tx import ARCHITECTURE, OWNERSHIP, make_panel, make_release


OPERATION_ID = "20261007T180000Z-abcdef"


@pytest.fixture
def listener():
    asked = threading.Event()
    channel = CancelListener(OPERATION_ID, asked.set)
    address = channel.start()
    try:
        yield channel, address, asked
    finally:
        channel.close()


def test_a_request_with_the_right_token_reaches_the_runner(listener):
    _channel, address, asked = listener

    assert send_cancel(address, OPERATION_ID) is True

    assert asked.is_set()


def test_the_listener_is_reachable_only_from_the_router_itself(listener):
    _channel, address, _asked = listener

    assert address["host"] == "127.0.0.1"
    assert len(address["token"]) >= 32


@pytest.mark.parametrize(
    ("token", "operation_id"),
    [("0" * 64, OPERATION_ID), (None, "20261007T180000Z-000000")],
)
def test_a_wrong_token_or_another_operation_is_not_obeyed(listener, token, operation_id):
    _channel, address, asked = listener
    forged = {**address, "token": token or address["token"]}

    assert send_cancel(forged, operation_id) is False

    assert not asked.is_set()


def test_a_client_that_says_nothing_does_not_stop_the_listener(listener):
    _channel, address, asked = listener
    with socket.create_connection((address["host"], address["port"]), timeout=3):
        pass

    assert send_cancel(address, OPERATION_ID) is True
    assert asked.is_set()


def test_nobody_answers_after_the_runner_is_gone():
    channel = CancelListener(OPERATION_ID, lambda: None)
    address = channel.start()
    channel.close()

    with pytest.raises(OSError):
        send_cancel(address, OPERATION_ID)


# --- исполнитель целиком --------------------------------------------------------------


def _cli():
    script = Path(__file__).resolve().parents[1] / "xkeen-ui" / "scripts" / "module_transaction.py"
    spec = importlib.util.spec_from_file_location("module_transaction_cli_cancel", script)
    cli = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cli)
    return cli


def test_the_runner_stops_when_the_panel_asks_it_to(tmp_path):
    cli = _cli()
    panel = make_panel(tmp_path)
    release = make_release()
    plan = build_plan("install", "tool.terminal", **{**panel.kwargs, "catalog": release.catalog})
    Journal.create(
        panel.root, plan, OPERATION_ID,
        extra={"health_url": "http://127.0.0.1:1/login", "restart_cmd": ["restart-panel"]},
    )
    asked: list[str] = []

    def ask_to_cancel(step: str) -> None:
        if step != "downloading":
            return
        asked.append(step)
        # Так же, как это делает панель: по записи операции, без номера процесса.
        # В тесте панель и исполнитель — один поток, поэтому отмена может
        # настичь его прямо здесь, не дожидаясь ответа.
        request_cancel(panel.root, panel.state, OPERATION_ID)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            time.sleep(0.01)

    previous = signal.getsignal(signal.SIGTERM)
    try:
        with patch.object(cli.subprocess, "run", lambda *_args, **_kwargs: None), patch.object(
            cli, "wait_for_panel", lambda *_args, **_kwargs: True
        ), patch.dict(os.environ, {"XKEEN_UI_UPDATE_DIR": str(tmp_path / "update")}):
            code = cli.main(
                ["run", "--panel-root", str(panel.root), "--state-dir", str(panel.state), "--operation", OPERATION_ID],
                client_factory=lambda state_dir, _architecture, _version: release.client(state_dir),
                architecture=ARCHITECTURE,
                on_step=ask_to_cancel,
            )
    finally:
        signal.signal(signal.SIGTERM, previous)

    status = read_status(panel.state)
    assert asked == ["downloading"]
    assert code == 1
    assert (status["result"], status["error_code"]) == ("interrupted", "operation_cancelled")
    assert not any(panel.path(path).exists() for path in OWNERSHIP["tool.terminal"])
    # Исполнитель ушёл — слушать больше некому.
    assert Journal.find(panel.root) is None
