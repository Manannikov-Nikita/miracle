<p align="center">
  <img src="docs/assets/miracle-banner.svg" alt="Miracle — от запроса к ясной картине. SQL, данные и мысли — рядом." width="1280" />
</p>

<p align="center"><strong>Личный SQL-редактор и аналитическая доска.</strong><br />ClickHouse · Trino · SQLite · Apache-2.0</p>

[Выпуски](https://github.com/Manannikov-Nikita/miracle/releases) · [Установка](docs/local-installation.md) · [Руководство](docs/usage.md) · [Что проверено](docs/release-validation.md)

Miracle работает на вашем компьютере и открывается в браузере. Подключитесь к ClickHouse или Trino, выполните SQL и соберите таблицы, графики и заметки на доске. Запросы, снимки и доски сохраняются локально. Аккаунт, регистрация, PostgreSQL и Docker для запуска не нужны.

**English:** Miracle is a personal local SQL workspace for ClickHouse and Trino. Run queries and turn result snapshots into charts, tables, and notes. It serves a Russian-language browser interface on loopback, stores its workspace in SQLite, and ships with its own runtime.

## Возможности

| Область | Что можно делать |
| --- | --- |
| SQL | Несколько .sql-вкладок, автодополнение, форматирование, запуск выделения или запроса под курсором, импорт и экспорт файлов. |
| Таблицы | Форматы колонок, условное оформление, фильтры, итоги и сводные — [подробнее](docs/table-capabilities.md). |
| Графики | Столбчатый, линейный, площадной и точечный графики; оси, серии, легенда и форматы чисел. |
| Доска | Снимки результатов, Markdown, заметки и связи; выравнивание, масштабирование, отмена и автосохранение. |
| Источники | ClickHouse и Trino; HTTPS, собственный CA и клиентские сертификаты для ClickHouse. |

Снимок хранит исходный SQL и контекст подключения. Его можно обновить независимо от открытого файла; при ошибке предыдущий результат остаётся. Проверка версий защищает доску от случайной перезаписи из другой вкладки.

## Установка

**0.2.0 готовится к выпуску.** Команда ниже станет доступна после публикации native-архивов и install.sh в GitHub Releases. Старый Docker-комплект 0.1.0 относится к другой версии приложения.

macOS и Linux:

```sh
curl -fsSL https://github.com/Manannikov-Nikita/miracle/releases/latest/download/install.sh | sh
miracle
```

Для Windows предусмотрен PowerShell-установщик. [Полная инструкция](docs/local-installation.md) содержит команду, ручную установку, обновление и резервное копирование.

Комплект содержит Node.js; устанавливать runtime, npm или Git отдельно не нужно. Сборки: macOS Intel/Apple Silicon, GNU/Linux x64/ARM64, Windows x64. ClickHouse или Trino подключаются отдельно.

`miracle` запускает сервис и открывает `http://127.0.0.1:3001`. Рабочая область открывается сразу, без входа.

```sh
miracle status
miracle stop
miracle start --port 3002
```

Приложение предназначено для одного человека на одном компьютере. Повторный запуск сохраняет данные. Автозапуск при входе в ОС не включается.

## Сохранность данных

SQLite и ключ шифрования подключений хранятся отдельно от версий программы. Команда `miracle backup DIRECTORY` сохраняет их вместе; перед копированием остановите сервис.

0.2.0 создаёт чистую рабочую область. Перенос из PostgreSQL-версии не выполняется; её данные не удаляются. SQL-черновики браузера сохраняйте в каталог запросов или скачивайте отдельно.

## Документация и разработка

- [Руководство](docs/usage.md) · [ClickHouse HTTPS](docs/clickhouse-connections.md).
- [Эксплуатация](docs/operations.md) · [Проверки](docs/release-validation.md).
- [Разработка](CONTRIBUTING.md) · [Публикация](docs/releasing.md).
- [Ошибки и предложения](https://github.com/Manannikov-Nikita/miracle/issues/new/choose) · [Безопасность](SECURITY.md).

Стек: React, TypeScript, Vite, Monaco, React Flow, ECharts, TanStack Table/Virtual, Radix; Node.js 24, Fastify и SQLite.

[Apache-2.0](LICENSE). Лицензии зависимостей — [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
