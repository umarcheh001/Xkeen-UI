# Сохранение истории при остановке — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans.

**Goal:** Медленное сохранение не теряет хвост истории при штатной остановке.
**Architecture:** tmp до flash в SIGTERM; init ждёт до15с и логирует SIGKILL.
**Tech Stack:** Python, POSIX sh, pytest.
**Spec:** docs/superpowers/specs/2026-10-29-history-shutdown.md.

## Global Constraints

Существующий pre-release; посторонние файлы не включать. Python/sh LF.
Без коммита/пуша/установки. Тесты до кода. Частота периодических записей прежняя.

## Task 1: Регрессия и исправление

- [x] RED: stop_service с процессом, которому нужно6с на сохранение, сохраняет
  результат; зависший процесс завершается не позднее15с.
- [x] RED: реальный collector оставляет свежую tmp-копию даже при ошибке flash;
  свежие сетевые отсчёты восстанавливаются из неё.
- [x] GREEN: collector.flush_collector пишет tmp до flash с независимой
  обработкой ошибок; stop_service ждёт до15с, логирует эскалацию.
- [x] Targeted collector/persist/init/provision/wiring pytest: 133 passed.

## Task 2: Завершение

- [x] Независимое read-only ревью; исправить важные находки.
- [x] Обновить описи, полный npm run test:py; журнал и память проекта.

## Review Focus

Ошибка tmp не мешает flash; EROFS flash не портит tmp; hung stop ограничен;
быстрый stop не ждёт15с; установщик ставит исправленную службу перед restart;
не трогать чужие PID; tmp/flash выбор последней копии и первый замер.
