from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]


def _run_node_json(script: str) -> object:
    if shutil.which("node") is None:
        pytest.skip("node is not available in this environment")

    result = subprocess.run(
        ["node", "--input-type=module"],
        input=script,
        capture_output=True,
        cwd=str(ROOT),
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout.strip())


def test_translate_monaco_schema_message_covers_property_pattern():
    script = """
import { translateMonacoSchemaMessage } from './xkeen-ui/static/js/ui/schema_diagnostic_format.js';

const cases = [
  'Property domainStrateg is not allowed.',
  'Missing property "outbounds".',
  'Incorrect type. Expected "string".',
  'Value is not accepted. Valid values: "direct", "block".',
  'String does not match the pattern of "^[a-z]+$".',
  'Array has too few items. Expected at least 1.',
  'Array should not contain duplicates.',
  'Matches multiple schemas when only one must validate.',
  'Some unrelated message that has no pattern',
];

console.log(JSON.stringify(cases.map((text) => ({
  input: text,
  ru: translateMonacoSchemaMessage(text),
}))));
"""
    payload = _run_node_json(script)
    by_input = {entry["input"]: entry["ru"] for entry in payload}

    assert by_input["Property domainStrateg is not allowed."] == "Свойство `domainStrateg` не разрешено схемой"
    assert by_input['Missing property "outbounds".'] == "Отсутствует обязательное свойство `outbounds`"
    assert by_input['Incorrect type. Expected "string".'] == "Неверный тип. Ожидается `string`"
    assert by_input['Value is not accepted. Valid values: "direct", "block".'].startswith(
        "Значение не разрешено. Допустимые значения:"
    )
    assert "шаблону" in by_input['String does not match the pattern of "^[a-z]+$".']
    assert "минимум 1" in by_input["Array has too few items. Expected at least 1."]
    assert by_input["Array should not contain duplicates."] == "Элементы массива должны быть уникальными"
    assert "oneOf" in by_input["Matches multiple schemas when only one must validate."]
    assert by_input["Some unrelated message that has no pattern"] is None


def test_format_enriched_message_appends_line_column_and_path():
    script = """
import { formatEnrichedMessage, isEnrichedMessage } from './xkeen-ui/static/js/ui/schema_diagnostic_format.js';

const baseMessage = 'Свойство `foo` не разрешено схемой';
const ctx = { line: 5, column: 12, pathLabel: 'routing.rules[0].domain' };

const out = formatEnrichedMessage(baseMessage, ctx);
const idempotent = formatEnrichedMessage(out, ctx);

console.log(JSON.stringify({
  out,
  idempotentSecondPass: idempotent,
  isEnrichedFirst: isEnrichedMessage(out),
  isEnrichedRaw: isEnrichedMessage(baseMessage),
}));
"""
    payload = _run_node_json(script)
    assert payload["out"] == (
        "Свойство `foo` не разрешено схемой (строка 5, столбец 12; путь routing.rules[0].domain)"
    )
    assert payload["isEnrichedFirst"] is True
    assert payload["isEnrichedRaw"] is False


def test_format_enriched_message_handles_root_label_and_missing_position():
    script = """
import { formatEnrichedMessage } from './xkeen-ui/static/js/ui/schema_diagnostic_format.js';

console.log(JSON.stringify({
  rootOnly: formatEnrichedMessage('msg', { line: 3, column: 2, pathLabel: 'root' }),
  noPos: formatEnrichedMessage('msg', { pathLabel: 'foo.bar' }),
  empty: formatEnrichedMessage('msg', {}),
}));
"""
    payload = _run_node_json(script)
    assert payload["rootOnly"] == "msg (строка 3, столбец 2)"
    assert payload["noPos"] == "msg (путь foo.bar)"
    assert payload["empty"] == "msg"


def test_find_pointer_at_range_returns_narrowest_match():
    script = """
import { buildJsoncPointerMap } from './xkeen-ui/static/js/vendor/codemirror_json_schema.js';
import { findPointerAtRange, diagnosticPointerLabel } from './xkeen-ui/static/js/ui/schema_diagnostic_format.js';

const text = `{
  "routing": {
    "domainStrategy": "IPIfNonMatch",
    "rules": [
      { "outboundTag": "direct", "domain": ["example.com"] }
    ]
  }
}`;
const map = buildJsoncPointerMap(text);
const ruleStart = text.indexOf('"outboundTag"');
const ruleEnd = ruleStart + '"outboundTag"'.length;
const fullRuleStart = text.indexOf('{', text.indexOf('"rules"'));
const fullRuleEnd = text.indexOf('}', fullRuleStart) + 1;

console.log(JSON.stringify({
  outboundKey: findPointerAtRange(map, ruleStart, ruleEnd),
  ruleObject: findPointerAtRange(map, fullRuleStart, fullRuleEnd),
  rootLabel: diagnosticPointerLabel(''),
  outboundLabel: diagnosticPointerLabel('/routing/rules/0/outboundTag'),
  arrayLabel: diagnosticPointerLabel('/routing/rules/0/domain/0'),
}));
"""
    payload = _run_node_json(script)
    assert payload["outboundKey"] == "/routing/rules/0/outboundTag"
    assert payload["ruleObject"] == "/routing/rules/0"
    assert payload["rootLabel"] == "root"
    assert payload["outboundLabel"] == "routing.rules[0].outboundTag"
    assert payload["arrayLabel"] == "routing.rules[0].domain[0]"


def test_enrich_schema_diagnostic_matches_cm6_format_for_property_error():
    text = (
        "{\n"
        '  "log": { "loglevel": "warning" },\n'
        '  "routing": {\n'
        '    "domainStrategy": "IPIfNonMatch",\n'
        '    "domainStrateg": "oops"\n'
        "  }\n"
        "}\n"
    )

    script = f"""
import {{ enrichSchemaDiagnostic }} from './xkeen-ui/static/js/ui/schema_diagnostic_format.js';

const text = {json.dumps(text)};
const offset = text.indexOf('"domainStrateg"');
const lines = text.slice(0, offset).split('\\n');
const line = lines.length;
const column = lines[lines.length - 1].length + 1;

const result = enrichSchemaDiagnostic({{
  message: 'Property domainStrateg is not allowed.',
  text,
  from: offset,
  to: offset + '"domainStrateg"'.length,
  line,
  column,
  source: 'Xray Routing Fragment',
}});

const idempotent = enrichSchemaDiagnostic({{
  message: result.message,
  text,
  from: offset,
  to: offset + '"domainStrateg"'.length,
  line,
  column,
  source: 'Xray Routing Fragment',
}});

console.log(JSON.stringify({{
  message: result.message,
  source: result.source,
  idempotent: idempotent.message,
  line,
  column,
}}));
"""
    payload = _run_node_json(script)

    assert payload["source"] == "Xray Routing Fragment"
    assert "Свойство `domainStrateg` не разрешено схемой" in payload["message"]
    assert f"строка {payload['line']}, столбец {payload['column']}" in payload["message"]
    assert "путь routing.domainStrateg" in payload["message"]
    assert payload["idempotent"] == payload["message"]


def test_enrich_schema_diagnostic_keeps_raw_message_when_pattern_unknown():
    script = """
import { enrichSchemaDiagnostic } from './xkeen-ui/static/js/ui/schema_diagnostic_format.js';

const result = enrichSchemaDiagnostic({
  message: 'Some unrecognized schema diagnostic',
  text: '{"foo": "bar"}',
  from: 0,
  to: 1,
  line: 1,
  column: 1,
  source: 'Test',
});
console.log(JSON.stringify(result));
"""
    payload = _run_node_json(script)
    assert payload["message"].startswith("Some unrecognized schema diagnostic")
    assert "(строка 1, столбец 1" in payload["message"]
    assert payload["source"] == "Test"


def test_enrich_schema_diagnostic_returns_null_for_empty_message():
    script = """
import { enrichSchemaDiagnostic } from './xkeen-ui/static/js/ui/schema_diagnostic_format.js';

const result = enrichSchemaDiagnostic({ message: '', text: '{}', from: 0, to: 0 });
console.log(JSON.stringify({ result }));
"""
    payload = _run_node_json(script)
    assert payload["result"] is None


def test_enriched_message_uses_marker_safe_separator_for_monaco_peek():
    """Monaco's MarkerNavigationWidget sizes itself by the logical newline
    count of the message, not visual wrap. A long single-line enriched
    message is therefore vertically clipped in the peek (Alt+F8).

    The fix in monaco_shared.js is to replace ' (строка ' with '\\n(строка '
    before pushing the marker. Verify that the suffix is still discoverable
    by the same separator the patcher relies on, so the fix keeps working
    if the formatter is touched later.
    """
    script = """
import { formatEnrichedMessage } from './xkeen-ui/static/js/ui/schema_diagnostic_format.js';

const message = formatEnrichedMessage('Свойство `foo` не разрешено схемой', {
  line: 5, column: 5, pathLabel: 'routing.rules[0].domain',
});
const swapped = message.replace(' (строка ', '\\n(строка ');
console.log(JSON.stringify({
  message,
  swapped,
  separatorPresent: message.includes(' (строка '),
  swappedLineCount: swapped.split('\\n').length,
}));
"""
    payload = _run_node_json(script)
    assert payload["separatorPresent"] is True, (
        "shared formatter must keep ' (строка ' so monaco_shared.js can split into two lines"
    )
    assert payload["swappedLineCount"] == 2
    assert payload["swapped"].split("\n", 1)[1].startswith("(строка ")


def test_enrich_schema_diagnostic_matches_cm6_diagnostic_context_format():
    """Parity check: enriched Monaco message uses the same '(строка N, столбец M; путь P)'
    suffix shape that CM6's withDiagnosticContext produces."""
    text = (
        "{\n"
        '  "routing": {\n'
        '    "rules": [\n'
        '      { "outboundTag": "ghost-tag" }\n'
        "    ]\n"
        "  }\n"
        "}\n"
    )

    script = f"""
import {{ enrichSchemaDiagnostic }} from './xkeen-ui/static/js/ui/schema_diagnostic_format.js';
import {{ buildJsoncPointerMap }} from './xkeen-ui/static/js/vendor/codemirror_json_schema.js';

const text = {json.dumps(text)};
const offset = text.indexOf('"ghost-tag"');
const lines = text.slice(0, offset).split('\\n');
const line = lines.length;
const column = lines[lines.length - 1].length + 1;

const monacoLike = enrichSchemaDiagnostic({{
  message: 'Value is not accepted. Valid values: "direct", "block".',
  text,
  from: offset,
  to: offset + '"ghost-tag"'.length,
  line,
  column,
  source: 'Xray Routing Fragment',
}});

console.log(JSON.stringify({{
  message: monacoLike.message,
  source: monacoLike.source,
  line,
  column,
}}));
"""
    payload = _run_node_json(script)

    assert "Значение не разрешено" in payload["message"]
    assert f"(строка {payload['line']}, столбец {payload['column']}; путь routing.rules[0].outboundTag)" in payload["message"]
    assert payload["source"] == "Xray Routing Fragment"
