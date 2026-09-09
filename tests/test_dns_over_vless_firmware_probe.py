"""Проба живости резолвера прошивки не должна верить одной датаграмме.

Резолвер прошивки на роутере — не локальный кеш: его апстримы зашифрованы и
уходят наружу (DoT и DoH), поэтому просевший на секунду канал легко съедает
единственный запрос. Ночью 9 сентября 2026 на 45.1 такой промах заставил
панель переприменить конфигурацию и перезапустить ядро Xray на ровном месте.

Здесь поднимается настоящий UDP-сокет: он молчит на заданное число первых
запросов и отвечает эхом на следующий. Ответ с тем же идентификатором — всё,
чего проба ждёт, поэтому эха достаточно.
"""

from __future__ import annotations

import socket
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "xkeen-ui"))

from services import dns_over_vless as dns  # noqa: E402


class _FlakyResolver:
    """UDP-резолвер, теряющий первые ``swallow`` запросов."""

    def __init__(self, swallow: int) -> None:
        self._swallow = swallow
        self.seen = 0
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.bind(("127.0.0.1", 0))
        self._sock.settimeout(0.2)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._serve, daemon=True)

    @property
    def label(self) -> str:
        host, port = self._sock.getsockname()
        return "%s:%d" % (host, port)

    def _serve(self) -> None:
        while not self._stop.is_set():
            try:
                data, peer = self._sock.recvfrom(4096)
            except socket.timeout:
                continue
            except OSError:
                return
            self.seen += 1
            if self.seen <= self._swallow:
                continue
            self._sock.sendto(data, peer)

    def __enter__(self) -> "_FlakyResolver":
        self._thread.start()
        return self

    def __exit__(self, *_exc) -> None:
        self._stop.set()
        self._thread.join(timeout=2)
        self._sock.close()


def test_the_probe_survives_one_lost_datagram():
    with _FlakyResolver(swallow=1) as resolver:
        assert dns._resolver_answers(resolver.label) is True
    assert resolver.seen >= 2, "проба обязана повторить запрос, а не сдаться с первого"


def test_the_probe_answers_at_once_when_the_resolver_is_healthy():
    with _FlakyResolver(swallow=0) as resolver:
        started = time.monotonic()
        assert dns._resolver_answers(resolver.label) is True
        elapsed = time.monotonic() - started
    assert resolver.seen == 1, "живой резолвер не нужно переспрашивать"
    assert elapsed < 1.0


def test_a_resolver_that_never_answers_stays_silent_within_the_budget():
    with _FlakyResolver(swallow=99) as resolver:
        started = time.monotonic()
        assert dns._resolver_answers(resolver.label) is False
        elapsed = time.monotonic() - started
    # Повторы живут внутри прежнего срока: выбор адреса при включении опрашивает
    # резолверы по очереди, и растянутая проба растянула бы включение.
    assert elapsed <= dns.FIRMWARE_PROBE_TIMEOUT + 0.5
