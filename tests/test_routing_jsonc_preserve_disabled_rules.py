from __future__ import annotations

import subprocess
import textwrap
from pathlib import Path

from tests.support.node_js import NODE_MODULE_COMMAND


ROOT = Path(__file__).resolve().parents[1]


def run_node(script: str) -> None:
    subprocess.run(
        [*NODE_MODULE_COMMAND, "-e", textwrap.dedent(script)],
        cwd=str(ROOT),
        check=True,
        text=True,
        capture_output=True,
    )


def test_render_rules_array_keeps_disabled_rule_blocks_when_active_rules_change():
    run_node(
        r"""
        import assert from 'node:assert/strict';
        import { getRoutingJsoncPreserveApi } from './xkeen-ui/static/js/features/routing_jsonc_preserve.js';

        const jp = getRoutingJsoncPreserveApi();
        assert.ok(jp);

        const raw = `{
          "routing": {
            "rules": [
              {
                "ruleTag": "a",
                "type": "field",
                "outboundTag": "direct"
              },
              //__XK_DISABLED_RULE_START__
              // {
              //   "ruleTag": "b",
              //   "type": "field",
              //   "outboundTag": "block"
              // }
              //__XK_DISABLED_RULE_END__
              {
                "ruleTag": "c",
                "type": "field",
                "outboundTag": "proxy"
              }
            ]
          }
        }`;

        const routingRange = jp.locateRoutingObject(raw);
        const rulesRange = jp.locateArrayByKey(raw, routingRange, 'rules');
        const segments = jp.splitJsoncArrayElements(raw, rulesRange);

        assert.equal(segments.length, 2);
        assert.equal(jp.extractDisabledRuleSegments(raw, rulesRange).length, 1);

        const changedRules = [
          segments[1].parsed,
          {
            ...segments[1].parsed,
            ruleTag: 'c-copy',
            outboundTag: 'direct',
          },
        ];

        const rendered = jp.renderRulesArray(raw, rulesRange, segments, changedRules);
        assert.equal(rendered.ok, true, rendered.error || 'render failed');

        const markerCount = (rendered.text.match(/__XK_DISABLED_RULE_START__/g) || []).length;
        assert.equal(markerCount, 1);
        assert.ok(
          rendered.text.indexOf('__XK_DISABLED_RULE_START__') < rendered.text.indexOf('"ruleTag": "c"'),
          'disabled block should stay before the next surviving active rule',
        );
        assert.match(rendered.text, /"ruleTag": "b"/);
        assert.doesNotMatch(rendered.text, /"ruleTag": "a"/);
        assert.match(rendered.text, /"ruleTag": "c"/);
        assert.match(rendered.text, /"ruleTag": "c-copy"/);

        const nextRaw = raw.slice(0, rulesRange.start) + rendered.text + raw.slice(rulesRange.end);
        const nextRoutingRange = jp.locateRoutingObject(nextRaw);
        const nextRulesRange = jp.locateArrayByKey(nextRaw, nextRoutingRange, 'rules');
        assert.equal(jp.extractDisabledRuleSegments(nextRaw, nextRulesRange).length, 1);
        assert.equal(jp.splitJsoncArrayElements(nextRaw, nextRulesRange).length, 2);
        """
    )
