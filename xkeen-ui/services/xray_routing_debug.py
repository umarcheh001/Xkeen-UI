"""Temporary per-rule Xray hooks and a bounded, authenticated event inbox."""
from __future__ import annotations

import base64
from collections import deque
import copy
import hashlib
import hmac
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import secrets
import subprocess
import threading
import time

from services import xray_transactions
from services.io.atomic import _atomic_write_json, _atomic_write_text
from utils.jsonc import strip_json_comments_text

HEADER = 'X-Xkeen-Routing-Token'
MIN_VERSION = (26, 3, 27)
MAX_EVENTS = 2048
TTL = 30


def _digest(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _endpoint(value):
    if not isinstance(value, str) or len(value) > 512:
        return None
    network = ''
    if value.startswith(('tcp:', 'udp:')):
        network, value = value.split(':', 1)
    match = re.fullmatch(r'(?:\[([^\]]+)\]|([^:\s]+)):(\d{1,5})', value)
    if not match or not 0 < int(match[3]) <= 65535:
        return None
    host = (match[1] or match[2]).lower().rstrip('.')
    try:
        host = str(ipaddress.ip_address(host))
    except ValueError:
        if not re.fullmatch(r'[a-z0-9.-]{1,253}', host):
            return None
    return network, host, str(int(match[3]))


class RoutingDebug:
    def __init__(self, configs_dir, state_dir):
        self.configs = Path(configs_dir)
        self.state_path = Path(state_dir) / 'xray-routing-debug.json'
        self._state = {'enabled': False, 'active': False, 'token': secrets.token_hex(32),
                       'rules': {}, 'originals': {}, 'generation': secrets.token_hex(8)}
        self._needs_cleanup = False
        try:
            saved = json.loads(self.state_path.read_text(encoding='utf8'))
            if not isinstance(saved, dict) or not re.fullmatch('[0-9a-f]{64}', str(saved.get('token', ''))):
                raise ValueError('Invalid state token')
            # Keep ownership even if damaged metadata cannot be trusted for correlation.
            self._state['token'] = saved['token']
            self._needs_cleanup = True
            if (type(saved.get('enabled')) is not bool or type(saved.get('active')) is not bool
                    or not isinstance(saved.get('rules'), dict) or not isinstance(saved.get('originals'), dict)
                    or not all(isinstance(key, str) and isinstance(rule, dict)
                               and isinstance(rule.get('tag'), str) and isinstance(rule.get('outbound'), str)
                               for key, rule in saved['rules'].items())):
                raise ValueError('Invalid state metadata')
            for name, original in saved['originals'].items():
                if (not isinstance(name, str) or not isinstance(original, dict)
                        or not isinstance(original.get('bytes'), str)
                        or not re.fullmatch('[0-9a-f]{64}', str(original.get('digest', '')))):
                    raise ValueError('Invalid original document')
                base64.b64decode(original['bytes'], validate=True).decode('utf-8')
            self._state.update({key: saved[key] for key in ('enabled', 'active', 'rules', 'originals')})
            self._state['fingerprint'] = saved.get('fingerprint', '')
            self._state['since'] = time.time() * 1000
            self._needs_cleanup = False
        except (OSError, ValueError):
            pass
        self._state['generation'] = secrets.token_hex(8)
        self._operations = threading.RLock()
        self._performing = False
        self._events_lock = threading.Lock()
        self._events = deque(maxlen=MAX_EVENTS)
        self._dropped = self._sequence = 0
        self._first_id = 1
        self._expired_until = 0
        self._version_cache = (None, '')

    def version(self):
        binary = xray_transactions.xray_binary()
        try:
            stat = os.stat(binary)
            signature = (binary, stat.st_mtime_ns, stat.st_size)
        except OSError:
            return ''
        if self._version_cache[0] != signature:
            value = ''
            try:
                result = subprocess.run([binary, 'version'], capture_output=True, text=True, timeout=3)
                match = re.search(r'\bXray\s+(\d+\.\d+\.\d+)\b', result.stdout or '')
                if result.returncode == 0 and match:
                    value = match[1]
            except (OSError, subprocess.TimeoutExpired):
                pass
            self._version_cache = (signature, value)
        return self._version_cache[1]

    def status(self):
        self._invalidate_changed_configs()
        version = self.version()
        try:
            supported = tuple(map(int, version.split('.'))) >= MIN_VERSION
        except ValueError:
            supported = False
        return {'enabled': bool(self._state['enabled']), 'active': bool(self._state['active']),
                'supported': supported, 'version': version, 'minimum_version': '26.3.27',
                'reason': '' if supported else ('Требуется Xray 26.3.27 или новее.' if version else 'Не удалось определить версию Xray.'),
                'skipped_rules': self._state.get('skipped_rules', 0),
                'generation': self._state['generation']}

    def _fingerprint(self):
        from services.xkeen import _process_ids
        files = []
        try:
            for path in sorted(self.configs.iterdir()):
                if path.suffix.lower() in {'.json', '.jsonc'}:
                    stat = path.stat()
                    files.append((path.name, stat.st_ino, stat.st_mtime_ns, stat.st_size))
        except OSError:
            return ''
        return _digest([files, os.environ.get('XKEEN_UI_PORT', '8088'), self.version(), _process_ids('xray')])

    def _invalidate_changed_configs(self):
        if not self._state['active']:
            return
        with self._operations:
            if self._state['active'] and self._state.get('fingerprint') != self._fingerprint():
                with self._events_lock:
                    self._state = {**self._state, 'active': False, 'rules': {},
                                   'generation': secrets.token_hex(8)}
                    self._events.clear()
                self._needs_cleanup = True

    def _documents(self):
        documents = {}
        for path in sorted(self.configs.iterdir()):
            if path.is_file() and path.suffix.lower() in {'.json', '.jsonc'}:
                raw = path.read_bytes()
                source = raw.decode('utf-8-sig')
                obj = json.loads(strip_json_comments_text(source))
                if not isinstance(obj, dict):
                    raise ValueError('Конфигурация Xray должна быть объектом.')
                documents[path] = (obj, source, raw)
        return documents

    def _owned(self, hook):
        return (isinstance(hook, dict) and isinstance(hook.get('headers'), dict)
                and hook['headers'].get(HEADER) == self._state['token']
                and str(hook.get('url', '')).startswith('http://127.0.0.1:')
                and '/api/xray-logs/routing-event/' in hook.get('url', ''))

    def apply(self, logging, *, writes=None, originals=None):
        """Prepare hooks before the caller's single core restart."""
        with self._operations:
            active = bool(logging and self._state['enabled'])
            if active and not self.status()['supported']:
                raise ValueError(self.status()['reason'])
            state = copy.deepcopy(self._state)
            if active:
                state['generation'] = secrets.token_hex(8)
            rules, replacements, sources = {}, {}, {}
            skipped = 0
            port = int(os.environ.get('XKEEN_UI_PORT', '8088')) if active else 0
            if active and not 0 < port <= 65535:
                raise ValueError('Некорректный порт панели.')
            documents = self._documents() if active or state['active'] or state['originals'] or self._needs_cleanup else {}
            for path, (original, source, raw) in documents.items():
                updated = copy.deepcopy(original)
                entries = updated.get('routing', {}).get('rules', [])
                if not isinstance(entries, list):
                    raise ValueError('routing.rules должен быть списком.')
                for index, rule in enumerate(entries):
                    if not isinstance(rule, dict):
                        continue
                    if self._owned(rule.get('webhook')):
                        del rule['webhook']
                    tag = rule.get('ruleTag')
                    if not active or not isinstance(tag, str) or not tag.strip():
                        continue
                    if len(tag) > 1024:
                        raise ValueError('Тег правила слишком длинный.')
                    if rule.get('webhook') is not None:
                        skipped += 1
                        continue
                    key = hashlib.sha256(f'{state["generation"]}:{path.name}:{index}:{_digest(rule)}'.encode()).hexdigest()[:24]
                    rules[key] = {'tag': tag, 'outbound': rule.get('outboundTag', '')}
                    rule['webhook'] = {'url': f'http://127.0.0.1:{port}/api/xray-logs/routing-event/{key}',
                                       'deduplication': 0, 'headers': {HEADER: state['token']}}
                if updated != original:
                    replacements[path.name] = updated
                    sources[path.name] = source
                    if path.name not in state['originals']:
                        state['originals'][path.name] = {'bytes': base64.b64encode(raw).decode(),
                                                        'digest': _digest(original)}
            if active and not rules:
                raise ValueError('Нет правил с ruleTag без пользовательского webhook.')
            if replacements and active:
                checked = xray_transactions.check_staged(str(self.configs), replacements)
                if checked.get('ok') is not True:
                    raise ValueError('Xray не подтвердил конфигурацию отладки. Файлы не изменены.')
            for name, obj in replacements.items():
                path = self.configs / name
                saved = state['originals'].get(name, {})
                if saved.get('applied_digest') and saved['applied_digest'] != hashlib.sha256(documents[path][2]).hexdigest():
                    saved['edited'] = True
                if (path.read_bytes() != documents[path][2]
                        or (originals is not None and originals.get(str(path)) != documents[path][2])):
                    raise ValueError('Конфигурация изменена другим запросом. Повторите действие.')
                if not active and not saved.get('edited') and saved.get('digest') == _digest(obj):
                    # Restore spelling/comments too, unless the owner edited this document.
                    text = base64.b64decode(saved['bytes']).decode('utf-8')
                elif path.suffix == '.jsonc' or '//' in sources[name] or '/*' in sources[name]:
                    from services.xray_subscriptions import _collect_jsonc_comments_by_semantic_key, _render_jsonc_with_comments
                    comments = _collect_jsonc_comments_by_semantic_key(sources[name], documents[path][0], header='')
                    text = _render_jsonc_with_comments(obj, comments, header='')
                else:
                    text = None
                if writes is not None:
                    writes[str(path)] = (text if text is not None else json.dumps(obj, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
                if text is None:
                    _atomic_write_json(str(path), obj)
                else:
                    _atomic_write_text(str(path), text)
                if active:
                    saved['applied_digest'] = hashlib.sha256((text if text is not None else json.dumps(obj, ensure_ascii=False, indent=2) + '\n').encode('utf-8')).hexdigest()
            changed = state['active'] != active or state['rules'] != rules or bool(replacements)
            state.update(active=active, rules=rules, skipped_rules=skipped)
            if changed:
                if not active:
                    state['generation'] = secrets.token_hex(8)
                if active:
                    state['since'] = time.time() * 1000
            if not active:
                state['originals'] = {}
            state['fingerprint'] = self._fingerprint() if active else ''
            if state != self._state or not self.state_path.exists():
                _atomic_write_json(str(self.state_path), state, mode=0o600)
            with self._events_lock:
                self._state = state
                self._needs_cleanup = False
                if changed:
                    self._events.clear()
                    self._dropped = 0
                    self._first_id = self._sequence + 1
                    self._expired_until = 0

    def perform(self, logging, action, *, enabled=None, recover=None, writes=None):
        with self._operations:
            if enabled is None and not self._state['enabled'] and not self._state['active']:
                return action()
            before = copy.deepcopy(self._state)
            paths = [str(p) for p in self.configs.iterdir() if p.is_file()] if logging or before['active'] or before['originals'] or self._needs_cleanup else []
            guard = xray_transactions.MemoryGuard(paths=paths + [str(self.state_path)])
            action_started = False
            writes = {} if writes is None else writes
            self._performing = True
            try:
                if enabled is not None:
                    if enabled and not self.status()['supported']:
                        raise ValueError(self.status()['reason'])
                    self._state = {**self._state, 'enabled': bool(enabled)}
                self.apply(logging, writes=writes, originals=guard._snap)
                writes[str(self.state_path)] = xray_transactions.MemoryGuard._read(str(self.state_path))
                action_started = True
                result = action()
                if not result[0]:
                    raise ValueError('Не удалось применить перезапуск Xray. Настройки возвращены.')
                if self._state['active']:
                    if any(xray_transactions.MemoryGuard._read(path) != writes.get(path, guard._snap[path]) for path in paths):
                        raise ValueError('Конфигурация изменена во время перезапуска. Повторите Пуск.')
                    self._state['fingerprint'] = self._fingerprint()
                    _atomic_write_json(str(self.state_path), self._state, mode=0o600)
                return result
            except Exception as exc:
                # A failed write may leave the original bytes; those need no rollback.
                expected = {path: value for path, value in writes.items()
                            if xray_transactions.MemoryGuard._read(path) != guard._snap.get(path)}
                conflicts = guard.restore(expected=expected)
                if self.state_path.exists():
                    os.chmod(self.state_path, 0o600)
                self._state = before
                with self._events_lock:
                    self._events.clear()
                if conflicts:
                    self._state.update(active=False, rules={}, generation=secrets.token_hex(8))
                    _atomic_write_json(str(self.state_path), self._state, mode=0o600)
                    raise ValueError('Конфигурация изменена другим запросом. Его изменения сохранены; полный откат не выполнен. Повторите Пуск.') from exc
                if action_started and recover is not None:
                    try:
                        recovered = recover()[0]
                    except Exception:
                        recovered = False
                    if not recovered:
                        raise ValueError('Не удалось применить перезапуск Xray. Настройки возвращены, но не удалось восстановить запуск Xray.') from exc
                raise
            finally:
                self._performing = False

    def control_runtime(self, action, execute):
        """Prepare this engine through the core's optional runtime extension."""
        from services.xray_log_api import load_xray_log_config
        from services.xkeen import is_xkeen_running
        from services.cores import core_runtime, read_last_core
        action = str(action).strip().lower()
        with self._operations:
            if self._performing or (not self._state['enabled'] and not self._state['active'] and not self._needs_cleanup):
                return execute()
            if (core_runtime().owner or read_last_core()) == 'mihomo':
                self._invalidate_changed_configs()
                return execute()
            if action not in {'start', 'stop', 'restart'} or (action == 'start' and is_xkeen_running()):
                return execute()
            logging = (action != 'stop' and self.status()['supported']
                       and load_xray_log_config().get('log', {}).get('loglevel', 'none') != 'none')
            try:
                return self.perform(logging, lambda: (execute(), ''))[0]
            except (ValueError, OSError):
                return False

    def configure(self, enabled, *, logging, restart):
        with self._operations:
            return self._configure(enabled, logging=logging, restart=restart)

    def _configure(self, enabled, *, logging, restart):
        current = self.status()
        if current['enabled'] == bool(enabled) and current['active'] == bool(logging and enabled) and not self._needs_cleanup:
            return {**current, 'restarted': False, 'ok': True}
        before = self._state['enabled']
        generation = self._state['generation']
        restarted = False
        def apply_runtime():
            nonlocal restarted
            if logging and (bool(enabled) != before or self._state['generation'] != generation):
                restarted = True
                return restart()
            return True, ''
        result = self.perform(logging, apply_runtime, enabled=enabled, recover=restart if logging else None)
        return {**self.status(), 'restarted': restarted, 'ok': bool(result[0])}

    def authorize(self, remote, token):
        try:
            loopback = ipaddress.ip_address(remote).is_loopback
        except (ValueError, TypeError):
            loopback = False
        return bool(self._state['active'] and loopback and isinstance(token, str)
                    and token.isascii()
                    and hmac.compare_digest(self._state['token'], token))

    def ingest(self, rule_key, event):
        state = self._state
        rule = state['rules'].get(rule_key)
        if not state['active'] or not rule or not isinstance(event, dict):
            return False
        source, target = _endpoint(event.get('source')), _endpoint(event.get('originalTarget'))
        routed = _endpoint(event.get('routeTarget')) if event.get('routeTarget') else None
        proto = event.get('network')
        stamp = event.get('ts')
        if (not source or not target or proto not in ('tcp', 'udp') or target[0] != proto
                or (source[0] and source[0] != proto)
                or isinstance(stamp, bool) or not isinstance(stamp, (int, float))
                or not math.isfinite(stamp) or not 0 <= stamp < 2**40
                or stamp * 1000 < state.get('since', 0)
                or (event.get('routeTarget') and (not routed or routed[0] != proto or routed[2] != target[2]))):
            return False
        for key in ('inboundTag', 'outboundTag'):
            if not isinstance(event.get(key), str) or not 0 < len(event[key]) <= 1024:
                return False
        if rule['outbound'] and event['outboundTag'] != rule['outbound']:
            return False
        domain = routed[1] if routed else ''
        try:
            ipaddress.ip_address(domain)
            domain = ''
        except ValueError:
            pass
        with self._events_lock:
            if self._state['generation'] != state['generation']:
                return False
            self._prune()
            if len(self._events) == MAX_EVENTS:
                self._dropped += 1
            self._sequence += 1
            self._events.append((time.monotonic(), {'id': self._sequence, 'stamp': stamp * 1000,
                'srcIp': source[1], 'srcPort': source[2], 'host': target[1], 'port': target[2],
                'proto': proto, 'inTag': event['inboundTag'], 'outTag': event['outboundTag'],
                'tag': rule['tag'], 'domain': domain}))
        return True

    def _prune(self):
        cutoff = time.monotonic() - TTL
        while self._events and self._events[0][0] < cutoff:
            _, event = self._events.popleft()
            self._expired_until = max(self._expired_until, event['stamp'] + 2000)

    def events(self):
        self._invalidate_changed_configs()
        with self._events_lock:
            self._prune()
            return {'generation': self._state['generation'], 'events': [item[1] for item in self._events],
                    'dropped': self._dropped, 'active': self._state['active'], 'since': self._state.get('since', 0),
                    'first_id': self._first_id, 'expired_until': self._expired_until}
