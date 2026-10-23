# Публикация Miracle

Репозиторий содержит исходники, development compose.yaml и отдельный release/compose.yaml. Локальная поставка не использует build, Node.js или Git на машине пользователя. В релиз включается строго заданный список файлов в scripts/build-release.mjs; рабочая папка целиком никогда не архивируется.

## Проверки перед первой публикацией

1. Создайте публичный GitHub-репозиторий и загрузите проверенные исходники. Проверьте `git status`: `.local`, `.env`, ключи, сертификаты, дампы и личные данные не должны попасть в Git. Локальный пример учётной записи также не публикуется.
2. Разрешите GitHub Actions. Workflow Checks запускает типы, тесты, настоящие ClickHouse/Trino и HTTPS/mTLS, сборку и чистую Docker-установку с восстановлением на **нативных Linux amd64 и arm64**. Отдельная Windows-задача проверяет PowerShell-скрипт. Полный пользовательский сценарий Windows/macOS проверяется на этих ОС отдельно; Linux CI не является такой проверкой.
3. Выполните ручную проверку ZIP на Windows 11 x64, macOS Intel/Apple Silicon и Linux x64/ARM64. В окружении нужны только Docker и браузер. Windows ARM указывается как экспериментальный.
4. Проверьте имя версии `X.Y.Z`, зависимости и THIRD_PARTY_NOTICES.md (`npm ci && npm run notices`). Обновите package.json/package-lock.json при выпуске новой версии. Для локальной подготовки: `node scripts/build-release.mjs OWNER/REPOSITORY X.Y.Z`. Архив и SHA-256 появятся в `.local/releases/`.

## Выпуск версии

Отдельное явное действие владельца — создание и отправка тега `vX.Y.Z`. Workflow Publish version сначала вызывает все проверки, затем публикует один образ `ghcr.io/<owner>/<repository>:X.Y.Z` для linux/amd64 и linux/arm64. Namespace берётся из GITHUB_REPOSITORY и приводится к нижнему регистру. В ZIP подставляется тот же фиксированный тег; `latest` не используется.

GitHub может создать новый GHCR package приватным даже для публичного репозитория. **При первой публикации владелец должен в настройках package выбрать Public.** Workflow проверяет скачивание с пустой Docker-конфигурацией без логина и не публикует ZIP, пока анонимный pull не проходит. Если эта проверка остановилась, поменяйте видимость package и повторите job. Пользователям не нужен аккаунт или токен GHCR.

После проверок workflow создаёт GitHub Release и загружает `miracle-X.Y.Z.zip` и `.sha256`. Повторный запуск может восстановить вложения прерванного выпуска. Уже выпущенную версию не следует переназначать на другой исходный код: для изменения выпускайте новый тег.

Публикация начинается только после отправки тега версии. Обычный запуск приложения или сборка ZIP ничего не публикуют.

## Состав ZIP

- compose.yaml с готовыми образами;
- start/stop/backup/restore для Windows и Unix, common.sh, local.ps1;
- settings.env с единственным параметром порта;
- README.md, LICENSE, THIRD_PARTY_NOTICES.md.

Образы содержат лицензии приложения/зависимостей и Node.js; лицензии Debian/PostgreSQL сохранены в штатных каталогах образа. Список npm-зависимостей фиксируется package-lock.json.

## Локальная приёмка разработчиком

```sh
npm ci
npm run notices
docker compose --profile test up -d --wait postgres clickhouse trino
npm test
npm run build
npm run test:integration
npx tsx tests/clickhouse-tls-integration.ts
docker build -t miracle-local-smoke:0.1.0 .
node tests/local-install-smoke.mjs
```

Smoke создаёт только собственные именованные volumes/контейнеры и удаляет их после проверки. `MIRACLE_SMOKE_KEEP=1` сохраняет тестовую среду и файл синтетических реквизитов с правами 0600 для ручного Browser QA. Не применяйте команды очистки smoke к пользовательским volumes.

Основание CI: [Docker multi-platform GitHub Actions](https://docs.docker.com/build/ci/github-actions/multi-platform/) и [GitHub publishing images](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images). Инструкции для пользователей и резервного копирования — [local-installation.md](local-installation.md).
