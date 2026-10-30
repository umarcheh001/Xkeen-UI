"""Persistent acknowledgements and scoped event exceptions."""

import json
import os

from services.io.atomic import _atomic_write_json
from .problems import _TYPES


class EventPreferences:
    def __init__(self, directory):
        self.path = os.path.join(directory, 'resource-event-preferences.json')
        self.read_error = False
        try:
            with open(self.path, encoding='utf-8') as source:
                data = json.load(source)
        except FileNotFoundError:
            data = {}
        except (OSError, ValueError):
            data = {}
            self.read_error = True
        if not isinstance(data, dict):
            data = {}
            self.read_error = True
        if not isinstance(data.get('acknowledged', []), list) or not isinstance(data.get('exclusions', []), list):
            self.read_error = True
        self.acknowledged = set(x for x in data.get('acknowledged', []) if isinstance(x, str)) if isinstance(data.get('acknowledged', []), list) else set()
        if isinstance(data.get('acknowledged', []), list) and any(not isinstance(x, str) for x in data.get('acknowledged', [])):
            self.read_error = True
        self.exclusions = set()
        entries = data.get('exclusions', [])
        if isinstance(entries, list):
            for entry in entries:
                if isinstance(entry, dict) and self.valid(entry.get('type'), entry.get('key')):
                    self.exclusions.add((entry['type'], entry['key']))
                else:
                    self.read_error = True

    @staticmethod
    def valid(event_type, key):
        return isinstance(event_type, str) and event_type in _TYPES and _TYPES[event_type][0] in ('problem', 'warning') and isinstance(key, str) and len(key) <= 256

    def save(self):
        if self.read_error:
            raise OSError('event preferences unavailable')
        _atomic_write_json(self.path, {'acknowledged': sorted(self.acknowledged), 'exclusions': [{'type': t, 'key': k} for t, k in sorted(self.exclusions)]})

    def acknowledge(self, event_id):
        if not isinstance(event_id, str) or not event_id or len(event_id) > 256:
            raise ValueError('invalid event id')
        old = self.acknowledged.copy()
        self.acknowledged.add(event_id)
        try:
            self.save()
        except OSError:
            self.acknowledged = old
            raise

    def is_acknowledged(self, event_id):
        return event_id in self.acknowledged

    def suppress(self, event_type, key):
        if not self.valid(event_type, key):
            raise ValueError('invalid event exception')
        old = self.exclusions.copy()
        self.exclusions.add((event_type, key))
        try:
            self.save()
        except OSError:
            self.exclusions = old
            raise

    def unsuppress(self, event_type, key):
        if not self.valid(event_type, key):
            raise ValueError('invalid event exception')
        old = self.exclusions.copy()
        self.exclusions.discard((event_type, key))
        try:
            self.save()
        except OSError:
            self.exclusions = old
            raise

    def is_suppressed(self, event_type, key):
        return (event_type, key) in self.exclusions

    def suppress_and_acknowledge(self, event_type, key, event_id):
        if not self.valid(event_type, key) or not isinstance(event_id, str) or not event_id or len(event_id) > 256:
            raise ValueError('invalid event exception')
        previous_exclusions = self.exclusions.copy()
        previous_acknowledged = self.acknowledged.copy()
        self.exclusions.add((event_type, key))
        self.acknowledged.add(event_id)
        try:
            self.save()
        except OSError:
            self.exclusions = previous_exclusions
            self.acknowledged = previous_acknowledged
            raise
