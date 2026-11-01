import { describe, expect, it } from "vitest";
import { describeError, type ErrorContext } from "../src/client/error-message";
import {
  connectionHttpError,
  queryErrorText,
  trinoQueryError,
} from "../src/server/connectionErrors";

describe("user-facing error descriptions", () => {
  const cases: {
    name: string;
    message: string;
    code?: string;
    details?: string;
    context?: ErrorContext;
    engine?: "clickhouse" | "trino";
    title: string;
    hint: RegExp;
  }[] = [
    {
      name: "DNS",
      message: "Не удалось подключиться",
      details: "getaddrinfo ENOTFOUND db.example",
      context: "connection",
      title: "Не удалось найти сервер базы данных.",
      hint: /имя сервера.*VPN/,
    },
    {
      name: "refused port",
      message: "connect ECONNREFUSED 127.0.0.1:8123",
      context: "connection",
      title: "Сервер отклонил подключение.",
      hint: /порт.*запущен/,
    },
    {
      name: "query timeout",
      message: "Request timed out",
      code: "ETIMEDOUT",
      context: "query",
      title: "Сервер не ответил вовремя.",
      hint: /запрос.*таймаут/,
    },
    {
      name: "Russian CA error",
      message:
        "Не удалось проверить сертификат TLS сервера Trino. Загрузите доверенный CA или его цепочку в формате PEM в настройках подключения.",
      engine: "trino",
      title: "Не удалось проверить сертификат сервера.",
      hint: /CA.*PEM/,
    },
    {
      name: "expired certificate",
      message: "certificate has expired",
      code: "CERT_HAS_EXPIRED",
      title: "Срок действия сертификата сервера истёк.",
      hint: /сертификат.*дату/,
    },
    {
      name: "certificate hostname",
      message: "Hostname/IP does not match certificate's altnames",
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
      title: "Адрес сервера не совпадает с сертификатом.",
      hint: /HTTPS.*сертификате/,
    },
    {
      name: "native port instead of HTTP",
      message:
        "Port 9000 is for clickhouse-client program. You must use port 8123 for HTTP.",
      engine: "clickhouse",
      title: "Указан порт другого протокола.",
      hint: /HTTP.*ClickHouse/,
    },
    {
      name: "HTTPS to HTTP",
      message: "SSL routines: wrong version number",
      code: "ERR_SSL_WRONG_VERSION_NUMBER",
      title: "Не удалось согласовать HTTPS-подключение.",
      hint: /http:\/\/.*https:\/\/.*порт/,
    },
    {
      name: "wrong credentials",
      message:
        "ClickHouse HTTP 403: Authentication failed: password is incorrect, or there is no user with such name. (AUTHENTICATION_FAILED)",
      context: "connection",
      title: "Сервер не принял имя пользователя или пароль.",
      hint: /имя пользователя.*пароль/,
    },
    {
      name: "forbidden is not a password diagnosis",
      message: "Engine HTTP 403: Access Denied",
      title: "Сервер запретил доступ.",
      hint: /права.*администратор/,
    },
    {
      name: "missing database",
      message:
        "Code: 81. DB::Exception: Database analytics does not exist. (UNKNOWN_DATABASE)",
      engine: "clickhouse",
      title: "База данных не найдена.",
      hint: /название базы/,
    },
    {
      name: "missing catalog",
      message: "Catalog 'warehouse' does not exist",
      engine: "trino",
      title: "Каталог Trino не найден.",
      hint: /каталог/,
    },
    {
      name: "missing schema",
      message: "Schema 'finance' does not exist",
      engine: "trino",
      title: "Схема не найдена.",
      hint: /схем.*каталог/,
    },
    {
      name: "browser cannot reach Miracle",
      message: "Failed to fetch",
      context: "connection",
      title: "Нет связи с Miracle.",
      hint: /локальный сервер Miracle.*запущен/,
    },
    {
      name: "expired local session",
      message: "Локальная сессия завершена",
      code: "LOCAL_SESSION_EXPIRED",
      title: "Сессия Miracle завершилась.",
      hint: /перезагрузите страницу/i,
    },
    {
      name: "different workspace",
      message: "Экземпляр проекта изменился. Перезагрузите страницу",
      code: "WORKSPACE_CHANGED",
      title: "Сервер открыл другую рабочую область.",
      hint: /черновики.*перезагрузите/i,
    },
    {
      name: "SQL syntax",
      message: "line 1:15: mismatched input 'FROM'. Expecting: <expression>",
      context: "query",
      title: "Ошибка в синтаксисе SQL.",
      hint: /строку.*SQL/,
    },
    {
      name: "query memory limit",
      message:
        "Code: 241. DB::Exception: Memory limit (total) exceeded. (MEMORY_LIMIT_EXCEEDED)",
      context: "query",
      title: "Запрос превысил доступный объём памяти.",
      hint: /данных.*JOIN|JOIN.*данных/,
    },
    {
      name: "clear Russian validation",
      message: "Введите название доски.",
      title: "Введите название доски.",
      hint: /^$/,
    },
    {
      name: "unknown server issue",
      message:
        "Unexpected engine state qx-712: partition metadata could not be reconciled",
      context: "connection",
      title: "Не удалось проверить подключение.",
      hint: /подробности/i,
    },
  ];

  it.each(cases)(
    "explains $name and preserves the returned diagnostics",
    ({ message, code, details, context, engine, title, hint }) => {
      const error = Object.assign(new Error(message), { code, details });
      const result = describeError(error, { context, engine });
      expect(result.title).toBe(title);
      expect(result.hint).toMatch(hint);
      expect(result.details).toContain(message);
      if (details) expect(result.details).toContain(details);
      if (code) expect(result.details).toContain(code);
    },
  );

  it("keeps full details once when they already contain the message and code", () => {
    const details =
      "Engine failed (SYNTAX_ERROR)\nline 42: unexpected token\n" +
      "x".repeat(6000);
    const result = describeError(
      {
        message: "Engine failed (SYNTAX_ERROR)",
        code: "SYNTAX_ERROR",
        details,
      },
      { context: "query" },
    );
    expect(result.details).toBe(details);
  });

  it("does not include unrelated object properties in diagnostics", () => {
    expect(
      describeError({
        message: "Operation rejected",
        password: "do-not-copy",
        config: { token: "private" },
      }).details,
    ).toBe("Operation rejected");
    expect(describeError(undefined).title).toBe(
      "Не удалось выполнить действие.",
    );
  });

  it("uses a forbidden HTTP status without guessing that the password is wrong", () => {
    const result = describeError(
      { message: "Ошибка 403", status: 403 },
      { context: "connection" },
    );
    expect(result.title).toBe("Сервер запретил доступ.");
    expect(result.hint).not.toMatch(/парол/);
    expect(result.details).toBe("Ошибка 403");
  });

  it.each([
    ["CONNECTION_DNS", "Не удалось найти сервер базы данных."],
    ["CONNECTION_REFUSED", "Сервер отклонил подключение."],
    ["CONNECTION_RESET", "Соединение с сервером прервано."],
    ["CONNECTION_NETWORK", "Не удалось подключиться к базе данных."],
    ["CONNECTION_TLS_CLIENT_CERT", "Сервер не принял сертификат клиента."],
    ["CONNECTION_TLS_HOSTNAME", "Адрес сервера не совпадает с сертификатом."],
    [
      "CONNECTION_TLS_EXPIRED",
      "Некорректный срок действия сертификата сервера.",
    ],
    ["CONNECTION_TLS_CA", "Не удалось проверить сертификат сервера."],
    ["CONNECTION_TLS_PROTOCOL", "Не удалось согласовать HTTPS-подключение."],
    ["CONNECTION_TIMEOUT", "Сервер не ответил вовремя."],
    ["CONNECTION_AUTH", "Сервер не принял имя пользователя или пароль."],
    ["CONNECTION_ACCESS", "Сервер запретил доступ."],
    ["CONNECTION_DATABASE", "База данных не найдена."],
    ["CONNECTION_CATALOG", "Каталог Trino не найден."],
    ["CONNECTION_SCHEMA", "Схема не найдена."],
    ["CONNECTION_ENDPOINT", "HTTP-адрес сервера не найден."],
    ["CONNECTION_REDIRECT", "Сервер перенаправляет подключение."],
    ["CONNECTION_HTTP", "Сервер базы данных вернул ошибку."],
  ])(
    "recognizes stable server code %s even without transport diagnostics",
    (code, title) => {
      const result = describeError({ message: "Connection failed", code });
      expect(result.title).toBe(title);
      expect(result.hint.length).toBeGreaterThan(0);
      expect(result.details).toContain(code);
    },
  );

  it("does not turn an agent authorization error into database permission advice", () => {
    const message =
      "Настройте или подтвердите команду агента на этом компьютере";
    const result = describeError({
      message,
      code: "AGENT_PROFILE_UNTRUSTED",
      status: 403,
    });
    expect(result.title).toBe(message);
    expect(result.hint).toBe("");
    expect(result.details).toContain("AGENT_PROFILE_UNTRUSTED");
  });

  it.each([
    ["query", "PERMISSION_DENIED"],
    ["query", "ACCESS_DENIED"],
    ["general", "PERMISSION_DENIED"],
    ["general", "ACCESS_DENIED"],
  ] as const)(
    "explains serialized Trino %s errors with %s after query history drops the object code",
    (context, errorName) => {
      const connection = {
        engine: "trino" as const,
        name: "Warehouse",
        url: "https://trino.test",
        username: "reader",
        password: "",
      };
      const text = queryErrorText(
        trinoQueryError(connection, {
          errorName,
          errorCode: 4,
          message: "Cannot select from table finance.accounts",
        }),
        connection,
      );
      const result = describeError(text, { context });
      expect(result.title).toBe("Сервер запретил доступ.");
      expect(result.hint).toContain("Проверьте права пользователя");
      expect(result.details).toBe(text);
    },
  );

  it("separates a ready Russian instruction from its problem without adding generic advice", () => {
    const message = "Подключение не найдено. Выберите другое подключение.";
    expect(describeError(new Error(message))).toEqual({
      title: "Подключение не найдено.",
      hint: "Выберите другое подключение.",
      details: message,
    });
  });

  it.each([
    [
      62,
      "Syntax error: failed at position 8 (ECONNREFUSED): ECONNREFUSED. Expected token. (SYNTAX_ERROR)",
      "Ошибка в синтаксисе SQL.",
    ],
    [
      241,
      "Memory limit exceeded while executing SELECT ENOTFOUND FROM logs. (MEMORY_LIMIT_EXCEEDED)",
      "Запрос превысил доступный объём памяти.",
    ],
  ] as const)(
    "prefers ClickHouse diagnostic Code %s over identifiers in its SQL excerpt",
    (code, detail, title) => {
      const connection = {
        engine: "clickhouse" as const,
        name: "Warehouse",
        url: "https://ch.test",
        username: "reader",
        password: "",
      };
      const error = connectionHttpError(
        connection,
        400,
        `Code: ${code}. DB::Exception: ${detail}`,
      );
      expect(describeError(error, { context: "query" }).title).toBe(title);
      expect(describeError(queryErrorText(error, connection)).title).toBe(
        title,
      );
    },
  );

  it.each([
    [
      "SYNTAX_ERROR",
      "line 1:8: mismatched input 'ECONNREFUSED'. Expecting: <expression>",
      "Ошибка в синтаксисе SQL.",
    ],
    [
      "EXCEEDED_LOCAL_MEMORY_LIMIT",
      "Memory limit exceeded while evaluating ENOTFOUND",
      "Запрос превысил доступный объём памяти.",
    ],
  ] as const)(
    "prefers the Trino %s diagnostic header over its SQL excerpt",
    (errorName, message, title) => {
      const connection = {
        engine: "trino" as const,
        name: "Warehouse",
        url: "https://trino.test",
        username: "reader",
        password: "",
      };
      const error = trinoQueryError(connection, {
        errorName,
        errorCode: 1,
        message,
      });
      expect(describeError(error, { context: "query" }).title).toBe(title);
      expect(describeError(queryErrorText(error, connection)).title).toBe(
        title,
      );
    },
  );

  it("explains a Zod field error without replacing its original JSON details", () => {
    const raw = JSON.stringify([
      {
        origin: "string",
        code: "invalid_format",
        format: "url",
        path: ["url"],
        message: "Invalid URL",
      },
    ]);
    const result = describeError(new Error(raw), { context: "connection" });
    expect(result.title).toBe("Некорректный адрес подключения.");
    expect(result.hint).toMatch(/http:\/\/.*https:\/\//);
    expect(result.details).toBe(raw);
  });
});
