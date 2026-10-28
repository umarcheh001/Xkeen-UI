# Сохранение fresh до NTP — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Сохранить достоверный подробный час при неверных часах загрузки.
**Architecture:** Отдельный временный _Tier fresh, ленивое создание; основной fresh заморожен до NTP. Файлы истории содержат только достоверные tiers.
**Tech Stack:** Python, pytest, существующий HistoryStore и FakeRouter.
**Spec:** docs/superpowers/specs/2026-10-28-router-history-ntp-preservation-design.md

## Global Constraints

- Совместимый формат version=1; прежние day/week, стартовое ожидание интернета и суточный предел сохраняются.
- Python LF; фронт не меняется. Существующие незакоммиченные изменения владельца и предыдущей задачи сохраняются.
- Коммит/пуш/релиз не выполняются без просьбы.

## Review Focus

- Повторные скачки назад: прежние точки не стираются и временные не смешиваются.
- Запрос сразу после NTP перед тиком: правильный буфер выбирается по времени запроса.
- Смена метрик и сохранение до NTP: сериализация сохраняет достоверные данные, копия не разделяет изменяемые массивы.
- Коллизия кольца: ложные даты с тем же индексом не перезаписывают сохранённый час.
- День неверных часов: прежнее правило give-up очищает устаревшую историю, временный буфер освобождается.

### Task 1: Отделить временный fresh

Files: xkeen-ui/services/system_resources_history/store.py; tests/test_system_resources_store.py; tests/test_system_resources_collector.py.
Interfaces: существующие add, columns_spec, with_metrics, to_dict/from_dict, add_metric, memory_bytes. Публичные сигнатуры не меняются.

- [x] Добавить тесты сохранности свежих средних и пиков после отката часов и NTP; коллизии индексов через сутки; запроса достоверного времени до тика; clone/remap/roundtrip. Обновить test_clock_jump_back_resets_only_fresh на проверку отдельного живого вида без потери доверенного часа.
- [x] Усилить сценарий test_reboot_with_the_clock_stepping_like_keeneticos разными нагрузками до reboot, до NTP и после NTP: прежние 40 и новые 20 остаются, временных 80 нет.
- [x] Запустить два файла pytest, увидеть падения именно на пропавших/загрязнённых точках; сохранить RED лог.
- [x] Добавить HistoryStore._unset_fresh: _Tier | None; add пишет в него при clock_unset, основной fresh сохраняется. columns_spec использует временный только для недостоверного времени. После выхода в достоверное время временный освобождается.
- [x] Распространить add_metric/with_metrics/memory_bytes на временный буфер; сериализовать только основные tiers, проверить копирование независимых массивов.
- [x] Повторить тесты, запросить отдельное read-only ревью согласно executing-plans, исправить существенные замечания RED→GREEN.
- [x] Добавить новые документы в индекс для генератора, npm.cmd run inventory:refresh. Полный npm run test:py из Git Bash, ожидается 0 failed; журнал .superpowers/sdd/2026-10-28-router-history-ntp-preservation/progress.md.
- [x] Записать итог в память; установка на роутеры — после подтверждения готовой правки либо по продолжающейся отмашке на приёмку.
