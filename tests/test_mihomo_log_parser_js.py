import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run_js(body, data=None):
    script = "import {parseMihomoLogEntry} from './xkeen-ui/static/js/features/mihomo_clash/log_parser.js';\n"
    script += "const data=" + json.dumps(data, ensure_ascii=False) + ";\n" + body
    result = subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", check=True)
    return json.loads(result.stdout)


def test_connection_variants_ipv6_nested_names_and_unknown_messages():
    corpus = json.loads((ROOT / "tests/fixtures/mihomo_clash/log-corpus.json").read_text(encoding="utf-8"))
    records = run_js("console.log(JSON.stringify(data.map((c,i)=>parseMihomoLogEntry({message:c.message,level:'info'},i+1))));", corpus["cases"])
    for case, record in zip(corpus["cases"], records):
        for key, value in case.items():
            assert record["raw" if key == "message" else key] == value


def test_dns_requires_positive_evidence_and_html_stays_plain_data():
    dto = {"message": "[UDP] 192.168.1.2:4000 --> 1.1.1.1:53 using DIRECT", "devices": [{"ip": "192.168.1.2", "name": "<b>Phone</b>"}], "fields": {"note": "<script>"}}
    rec = run_js("console.log(JSON.stringify(parseMihomoLogEntry(data,42)));", dto)
    assert rec["kind"] == "direct"
    assert rec["type"] == "connection"
    assert rec["raw"] == dto["message"]
    assert rec["devices"] == dto["devices"]
    assert rec["fields"] == dto["fields"]
    assert "<b>phone</b>" in rec["search"]
