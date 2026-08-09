from __future__ import annotations

import pytest

from services.mihomo_clash_stream import (
    BoundedNDJSONParser,
    MihomoClashPayloadError,
    parse_bounded_json,
)


def test_parse_bounded_json_accepts_utf8_object():
    assert parse_bounded_json('{"name":"узел"}'.encode()) == {"name": "узел"}


@pytest.mark.parametrize(
    ("payload", "code"),
    [
        (b"{}x", "upstream_invalid_json"),
        (b"\xff", "upstream_encoding_invalid"),
        (b"{\"long\":true}", "upstream_payload_too_large"),
    ],
)
def test_parse_bounded_json_returns_stable_safe_codes(payload: bytes, code: str):
    limit = 4 if code == "upstream_payload_too_large" else 1024
    with pytest.raises(MihomoClashPayloadError) as captured:
        parse_bounded_json(payload, max_bytes=limit)
    assert captured.value.code == code


def test_ndjson_parser_handles_partial_and_final_frames():
    parser = BoundedNDJSONParser(max_frame_bytes=128)
    assert parser.feed(b'{"sequence":1') == []
    assert parser.feed(b'}\r\n\n{"sequence":') == [{"sequence": 1}]
    assert parser.feed(b"2}") == []
    assert parser.finish() == [{"sequence": 2}]
    assert parser.buffered_bytes == 0


def test_ndjson_parser_rejects_oversized_unterminated_frame_and_clears_buffer():
    parser = BoundedNDJSONParser(max_frame_bytes=8)
    with pytest.raises(MihomoClashPayloadError) as captured:
        parser.feed(b"123456789")
    assert captured.value.code == "upstream_frame_too_large"
    assert parser.buffered_bytes == 0
