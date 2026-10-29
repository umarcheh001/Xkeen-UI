#!/usr/bin/env python3
"""Capture Stage 0 source contracts. No imports of application code or secrets."""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
MOSCOW = timezone(timedelta(hours=3), 'MSK')  # no DST since 2014; Windows Python has no tz database
SOURCES = [
    'xkeen-ui/templates/panel/modals/mihomo.html',
    'xkeen-ui/static/js/features/mihomo_import.js',
    'xkeen-ui/static/js/features/mihomo_proxy_tools.js',
    'xkeen-ui/static/js/features/mihomo_hwid_sub.js',
    'xkeen-ui/static/js/features/compat/mihomo_import.js',
    'xkeen-ui/static/js/pages/panel.lazy_bindings.runtime.js',
    'xkeen-ui/static/js/ui/modal.js',
    'xkeen-ui/static/js/ui/country_flags.js',
    'xkeen-ui/static/js/features/mihomo_panel.js',
    'xkeen-ui/static/js/features/mihomo_yaml_patch.js',
    'xkeen-ui/routes/mihomo.py',
    'xkeen-ui/services/mihomo_node_import.py',
    'xkeen-ui/services/mihomo_proxy_parsers.py',
    'xkeen-ui/services/mihomo_proxy_config.py',
    'xkeen-ui/services/mihomo_subscriptions.py',
    'xkeen-ui/services/mihomo_runtime.py',
    'xkeen-ui/static/styles.css',
    'xkeen-ui/static/panel-operator.css',
]


def collect() -> dict:
    text = (ROOT / SOURCES[1]).read_text(encoding='utf-8')
    template = (ROOT / SOURCES[0]).read_text(encoding='utf-8')
    template = template[template.index('<!-- Mihomo: import'):template.index('<!-- Mihomo: proxy tools')]
    sources = []
    for name in SOURCES:
        raw = (ROOT / name).read_bytes()
        sources.append({'path': name, 'sha256': hashlib.sha256(raw).hexdigest(), 'lines': len(raw.splitlines())})
    consumers = []
    pattern = re.compile(r'getMihomoImportApi|generateConfigForMihomo|proxyYamlRawFromIndented|openMihomoImport|openWithInput')
    for file in sorted((ROOT / 'xkeen-ui/static/js').rglob('*.js')):
        if file.name == 'mihomo_import.js':
            continue
        for number, line in enumerate(file.read_text(encoding='utf-8').splitlines(), 1):
            if pattern.search(line) and ('mihomo' in str(file) or 'mihomo' in line.lower()):
                consumers.append({'path': str(file.relative_to(ROOT)), 'line': number, 'source': line.strip()})
    mode_select = re.search(r'<select\b[^>]*\bid="mihomo-import-mode"[^>]*>(.*?)</select>', template, re.S)
    return {
        'schema_version': 1,
        'base_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'capture_date': datetime.now(MOSCOW).date().isoformat(),
        'scope': 'source contracts; endpoint paths include dynamic prefixes; not runtime/API reachability claims',
        'sources': sources,
        'dom_ids': re.findall(r'\bid="([^"]+)"', template),
        'modes': re.findall(r'<option value="([^"]+)">([^<]+)', mode_select.group(1)) if mode_select else [],
        'preferences': re.findall(r"const (\w*PREF_KEY|\w*REMEMBER_KEY|MODE_PREF_KEY) = '([^']+)'", text),
        'api_path_literals': sorted(set(re.findall(r"['\"](/api/mihomo/[^'\"\s]+)['\"]", text))),
        'facade_methods': sorted(set(re.findall(r'\bMI\.(\w+)\s*=', text))),
        'esm_exports': re.findall(r'export (?:function|const) (\w+)', text),
        'consumers': consumers,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=ROOT / '.tmp/mihomo-import-source-inventory.json')
    args = parser.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(collect(), ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(args.out)


if __name__ == '__main__':
    main()
