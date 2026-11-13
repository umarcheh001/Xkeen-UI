import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(body):
    script = (
        "import assert from 'node:assert/strict';"
        " import {mihomoLogRowText} from './xkeen-ui/static/js/features/mihomo_clash/log_export.js';"
        + body
        + ";console.log('true')"
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        capture_output=True,
        encoding="utf-8",
        check=True,
    )
    return json.loads(result.stdout)


def test_tsv_keeps_the_source_message_of_a_system_error():
    assert run(
        "const r={time:'13:00:00',sourceIp:'192.168.10.13',destination:'',group:'',"
        "node:'',rule:'',destinationPort:'',network:'',level:'error',"
        "raw:'[error] proxy request to host.test: i/o timeout',type:'message'};"
        "const cols=mihomoLogRowText(r,true).split('\\t');"
        "assert.equal(cols.length,10);"
        "assert.equal(cols.at(-1),'[error] proxy request to host.test: i/o timeout');"
    )


def test_tsv_escapes_tabs_and_line_breaks_inside_a_cell():
    assert run(
        "const r={level:'error',raw:'a\\tb\\nc\\rd'};"
        "const cols=mihomoLogRowText(r,true).split('\\t');"
        "assert.equal(cols.length,10);"
        "assert.equal(cols.at(-1),'a b c d');"
        "assert.equal(mihomoLogRowText(r,false),'a\\tb\\nc\\rd');"
    )


def test_tsv_keeps_connection_columns_before_the_message():
    assert run(
        "const raw='[TCP] 192.168.10.13:40321 --> host1.test:443 match RuleSet(google@domain) using Google[PL Warsaw]';"
        "const r={time:'13:21:42',sourceIp:'192.168.10.13',destination:'host1.test',"
        "group:'Google',node:'PL Warsaw',rule:'RuleSet(google@domain)',destinationPort:'443',"
        "network:'tcp',level:'info',raw};"
        "const cols=mihomoLogRowText(r,true).split('\\t');"
        "assert.deepEqual(cols.slice(0,9),['13:21:42','192.168.10.13','host1.test','Google',"
        "'PL Warsaw','RuleSet(google@domain)','443','tcp','info']);"
        "assert.equal(cols[9],raw);"
    )
