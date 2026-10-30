# Trino Corporate CA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Установленный Miracle подключается к Trino HTTPS с выбранным корпоративным CA без ручной правки launcher.

**Architecture:** Optional trino.tls.caCert, зашифрованный в SQLite, и отдельный TLS dispatcher на запрос. Публичный API отдаёт только флаг наличия. UI следует существующей форме ClickHouse.

**Tech Stack:** Node 24.22.2, TypeScript, undici, Fastify, SQLite/SecretBox, React, Vitest.

**Spec:** docs/superpowers/specs/2026-10-30-trino-corporate-ca-design.md

## Global Constraints

- CA PEM до 128 КиБ; только HTTPS, проверка сервера всегда включена.
- SQLite schema 3 с миграциями и backup/restore старых схем 1/2.
- Поддержка macOS x64/arm64, Linux x64/arm64 и Windows через WSL.
- Только синтетические сертификаты в проверках; пользовательские данные не читаются и не публикуются.

## Review Focus

- DELETE после закрытия основного dispatcher и параллельной отмены: транспортные HTTPS-тесты.
- Пропуск CA при редактировании и явное удаление: API/UI-тесты.
- Поздняя загрузка файла после закрытия/смены формы: UI-тест.
- Перенос CA между источниками и неверное имя сервера: TLS-тесты.
- Обновление установленной версии и восстановление старой копии: storage/native smoke.

## Tasks

- [x] Контракт, PEM-валидация, encrypted column, DTO, merge и SQLite migration в types/validation/trinoOptions/app/db/maintenance; API/storage регрессии.
- [x] Transport в connectors/trinoTransport и production dependency undici; HTTPS red→green, paging/cancel/identity/isolation и безопасные ошибки.
- [x] TrinoConnectionOptions, интеграция Connections, чтение/удаление CA, UI-тесты и документация Trino/Node CA.
- [x] Native archive smoke: проверить копируемый установленный runtime, CA в сохранённом источнике, переустановку и backup/restore.
- [x] Объединённые тесты, typecheck/build, browser QA, независимое ревью, исправление найденных регрессий.
- [x] Подготовить версию и release notes, проверить архивы и доступность исправления через установку GitHub.
