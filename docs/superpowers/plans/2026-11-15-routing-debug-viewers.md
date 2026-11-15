# Routing debug viewers Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans; выполнить в текущей папке, один писатель.

**Goal:** Выключать отладку через 30 секунд после ухода последнего зрителя.
**Architecture:** Авторизованный POST-поток присутствия и серверный таймер в RoutingDebug.
**Tech Stack:** Flask, threading, существующий JS fetch/AbortController.
**Spec:** docs/superpowers/specs/2026-11-15-routing-debug-viewers-design.md

## Global Constraints

- 30 секунд без зрителей, сообщения потока каждые 5 секунд.
- Пауза/фоновая вкладка сохраняют присутствие; другой экран панели и pagehide отменяют поток.
- Снятие hooks через configure(False), loglevel не менять; ошибки не скрывать.
- Никаких новых зависимостей, пуша, установки без адреса и пароля.

## Review Focus

- Два зрителя: закрытие одного не отключает режим.
- Перезагрузка/возврат до срока отменяет выключение.
- Восстановленное серверное состояние без браузеров тоже отключается.
- Ошибка перезапуска сохраняет hooks и получает повтор, ручное выключение отменяет таймер.
- Авторизация и CSRF потока не ослабляются, фоновая вкладка не закрывает поток.

## Task 1: Присутствие и отключение

Files: services/xray_routing_debug.py, routes/xray_logs.py, static/js/features/xray_logs.js
(в xkeen-ui), tests/test_xray_routing_debug.py, e2e/xray_log_rules.spec.mjs,
docs/xray-logs-screen.md.

- [x] Добавить Python-тесты нескольких зрителей, срока, возврата, ошибки и startup.
- [x] Запустить с уникальным коротким basetemp вне песочницы, подтвердить RED.
- [x] Добавить серверный таймер и POST-поток; существующий configure выполняет отключение.
- [x] Добавить браузерный тест потока на паузе, при background и навигации; подтвердить RED.
- [x] Подключить поток к состоянию экрана, pagehide/pageshow и статусу; без зависимости от Live.
- [x] Адресный Python, JS, frontend build и связанный e2e; проверить LF/diff и описи.
- [x] Независимое read-only ревью, исправления и обновление памяти/handoff.

Коммит/пуш не запрошены. Установка разрешена на192.168.45.1; выполняется отдельно.
