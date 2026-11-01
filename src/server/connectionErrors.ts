import type { EngineConnection } from "./connectors.js";
import type { ZodError } from "zod";

export const CONNECTION_ERROR_MAX_BYTES = 1024 * 1024;
export const CONNECTION_ERROR_TOO_LARGE =
  "Ответ превышает 1 МБ; полные подробности доступны в журнале сервера БД.";

/** Only deliberately sanitized diagnostics may cross the HTTP error boundary. */
export class ConnectionDiagnosticError extends Error {
  readonly statusCode = 400;
  constructor(
    message: string,
    readonly code: string,
    readonly details?: string,
  ) {
    super(message);
  }
}

export function connectionValidationError(error: ZodError) {
  const first = error.issues[0];
  const path = first?.path.map(String).join(".") || "";
  const field = String(first?.path[0] ?? "");
  const messages: Record<string, string> = {
    name: "Введите название подключения: от 1 до 200 символов.",
    engine: "Выберите тип базы данных: ClickHouse или Trino.",
    url: "Проверьте адрес сервера: укажите полный URL с http:// или https://.",
    username:
      "Проверьте имя пользователя: оно должно быть строкой не длиннее 200 символов.",
    password:
      "Проверьте пароль: он должен быть строкой не длиннее 10 000 символов.",
    database:
      "Проверьте поле «База данных»: укажите название не длиннее 200 символов.",
    catalog:
      "Проверьте поле «Каталог»: укажите название не длиннее 200 символов.",
    schema: "Проверьте поле «Схема»: укажите название не длиннее 200 символов.",
  };
  let message =
    messages[field] ||
    "Некорректные параметры подключения. Проверьте поля, перечисленные в подробностях.";
  if (path === "clickhouse.requestTimeoutMs")
    message = "Недопустимый таймаут HTTP. Укажите от 1 до 600 секунд.";
  else if (path.startsWith("clickhouse.settings"))
    message =
      "Недопустимое значение параметра ClickHouse. Проверьте формат и допустимый диапазон параметра в подробностях.";
  else if (path.includes(".tls"))
    message =
      "Некорректный файл сертификата или ключа. Используйте текстовый PEM-файл размером до 128 КиБ.";
  // Zod issues carry safe schema paths/messages. Do not serialize issues wholesale:
  // future/custom issue objects can also carry input, keys or certificate material.
  const details = error.issues
    .map(
      (issue) =>
        `${issue.path.map(String).join(".") || "connection"}: ${issue.message}`,
    )
    .join("\n")
    .replace(
      /-----BEGIN [^-]+-----[\s\S]*?(?:-----END [^-]+-----|$)/g,
      "[скрыто]",
    );
  return new ConnectionDiagnosticError(message, "VALIDATION_ERROR", details);
}

export function connectionTransportError(
  engine: "ClickHouse" | "Trino",
  error: unknown,
  signal?: AbortSignal | null,
) {
  const codes = new Set<string>();
  const seen = new Set<unknown>();
  const pending = [error];
  while (pending.length && seen.size < 32) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const detail = current as {
      code?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (typeof detail.code === "string") codes.add(detail.code);
    pending.push(detail.cause);
    if (Array.isArray(detail.errors))
      pending.push(...detail.errors.slice(0, 32));
  }
  const rules: [string[], string, string][] = [
    [
      ["ERR_TLS_CERT_ALTNAME_INVALID"],
      "CONNECTION_TLS_HOSTNAME",
      `Имя сервера ${engine} не совпадает с сертификатом TLS. Проверьте HTTPS-адрес подключения.`,
    ],
    [
      ["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID"],
      "CONNECTION_TLS_EXPIRED",
      `Сертификат TLS сервера ${engine} просрочен или ещё не действует. Проверьте сертификат и дату на компьютере.`,
    ],
    [
      [
        "DEPTH_ZERO_SELF_SIGNED_CERT",
        "SELF_SIGNED_CERT_IN_CHAIN",
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        "UNABLE_TO_GET_ISSUER_CERT",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "CERT_UNTRUSTED",
        "INVALID_CA",
        "CERT_SIGNATURE_FAILURE",
      ],
      "CONNECTION_TLS_CA",
      `Не удалось проверить сертификат TLS сервера ${engine}. Загрузите доверенный CA или его цепочку в формате PEM в настройках подключения.`,
    ],
    [
      [
        "ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED",
        "ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE",
        "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA",
      ],
      "CONNECTION_TLS_CLIENT_CERT",
      `Сервер ${engine} отклонил сертификат клиента. Проверьте сертификат, закрытый ключ и доверие сервера к их CA.`,
    ],
    [
      [
        "ERR_SSL_WRONG_VERSION_NUMBER",
        "ERR_SSL_PACKET_LENGTH_TOO_LONG",
        "EPROTO",
      ],
      "CONNECTION_TLS_PROTOCOL",
      `Не удалось согласовать TLS с ${engine}. Проверьте протокол HTTP/HTTPS и соответствующий ему порт.`,
    ],
    [
      ["ENOTFOUND", "EAI_AGAIN"],
      "CONNECTION_DNS",
      `Не удалось найти сервер ${engine}. Проверьте имя сервера, сеть и подключение к VPN.`,
    ],
    [
      ["ECONNREFUSED"],
      "CONNECTION_REFUSED",
      `Сервер ${engine} отклонил соединение. Проверьте адрес, порт, запуск сервера и доступность сети.`,
    ],
    [
      [
        "ETIMEDOUT",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT",
      ],
      "CONNECTION_TIMEOUT",
      `Истёк таймаут подключения к ${engine}. Проверьте доступность сервера, сеть и VPN; затем повторите проверку.`,
    ],
    [
      ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"],
      "CONNECTION_RESET",
      `Соединение с ${engine} было прервано. Проверьте доступность сервера и прокси; затем повторите проверку.`,
    ],
  ];
  if (signal?.aborted)
    return new ConnectionDiagnosticError(
      `Запрос ${engine} отменён или истёк таймаут. Повторите проверку и убедитесь, что сервер доступен.`,
      "CONNECTION_TIMEOUT",
      `${engine}: операция прервана до завершения.`,
    );
  for (const [known, code, message] of rules) {
    const matched = known.filter((value) => codes.has(value));
    if (matched.length)
      return new ConnectionDiagnosticError(
        message,
        code,
        `${engine}: ${matched.join(", ")}`,
      );
  }
  // Raw TLS errors, arbitrary codes and causes may contain connection secrets.
  return new ConnectionDiagnosticError(
    `Не удалось подключиться к ${engine}; проверьте адрес, доступность сети и настройки TLS.`,
    "CONNECTION_NETWORK",
  );
}

export function redactConnectionText(
  text: string,
  connection: EngineConnection,
) {
  let safe = text;
  const tls = connection.clickhouse?.tls;
  for (const secret of [
    connection.password,
    tls?.caCert,
    tls?.clientCert,
    tls?.clientKey,
    connection.trino?.tls?.caCert,
    Buffer.from(`${connection.username}:${connection.password}`).toString(
      "base64",
    ),
  ]) {
    if (secret) safe = safe.split(secret).join("[скрыто]");
  }
  return safe.replace(
    /-----BEGIN [^-]+-----[\s\S]*?(?:-----END [^-]+-----|$)/g,
    "[скрыто]",
  );
}

/** Query history has one error field; retain the complete safe engine diagnostic. */
export function queryErrorText(error: unknown, connection: EngineConnection) {
  if (error instanceof ConnectionDiagnosticError) {
    const text = error.details
      ? error.details.includes(error.message)
        ? error.details
        : `${error.message}\n\n${error.details}`
      : error.message;
    return redactConnectionText(text, connection);
  }
  return redactConnectionText(
    String(error instanceof Error ? error.message : error || "Ошибка запроса"),
    connection,
  ).slice(0, 4000);
}

export function connectionHttpError(
  connection: EngineConnection,
  status: number,
  text: string,
) {
  const engine = connection.engine === "clickhouse" ? "ClickHouse" : "Trino";
  const details = `${engine} HTTP ${status}${text ? ": " + redactConnectionText(text, connection) : ""}`;
  const clickhouseCode =
    connection.engine === "clickhouse"
      ? /^\s*Code:\s*(\d+)\./.exec(text)?.[1]
      : undefined;
  if (clickhouseCode === "81")
    return new ConnectionDiagnosticError(
      "База данных ClickHouse не найдена. Проверьте поле «База данных» в настройках подключения.",
      "CONNECTION_DATABASE",
      details,
    );
  if (status === 401 || clickhouseCode === "516")
    return new ConnectionDiagnosticError(
      `Сервер ${engine} отклонил вход. Проверьте имя пользователя и пароль.`,
      "CONNECTION_AUTH",
      details,
    );
  if (status === 403)
    return new ConnectionDiagnosticError(
      `Сервер ${engine} запретил доступ. Проверьте права пользователя и правила доступа на сервере или прокси.`,
      "CONNECTION_ACCESS",
      details,
    );
  if (status === 404)
    return new ConnectionDiagnosticError(
      `Адрес ${engine} не найден. Проверьте URL, порт и путь HTTP-интерфейса.`,
      "CONNECTION_ENDPOINT",
      details,
    );
  if (status >= 300 && status < 400)
    return new ConnectionDiagnosticError(
      `Сервер ${engine} перенаправляет запрос. Укажите конечный адрес HTTP-интерфейса.`,
      "CONNECTION_REDIRECT",
      details,
    );
  return new ConnectionDiagnosticError(
    `Сервер ${engine} вернул ошибку HTTP ${status}. Проверьте его состояние и сообщение в подробностях.`,
    "CONNECTION_HTTP",
    details,
  );
}

export function trinoQueryError(connection: EngineConnection, value: unknown) {
  const error =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const name =
    typeof error.errorName === "string" &&
    /^[A-Z][A-Z0-9_]{0,79}$/.test(error.errorName)
      ? error.errorName
      : undefined;
  const number = Number.isSafeInteger(error.errorCode)
    ? String(error.errorCode)
    : undefined;
  const message = redactConnectionText(
    typeof error.message === "string" ? error.message : "Trino query failed",
    connection,
  );
  const details = redactConnectionText(
    ["Trino", name, number && `Code: ${number}`, message]
      .filter(Boolean)
      .join("\n"),
    connection,
  );
  if (name === "CATALOG_NOT_FOUND")
    return new ConnectionDiagnosticError(
      "Каталог Trino не найден. Проверьте поле «Каталог» в настройках подключения.",
      "CONNECTION_CATALOG",
      details,
    );
  if (name === "SCHEMA_NOT_FOUND")
    return new ConnectionDiagnosticError(
      "Схема Trino не найдена. Проверьте каталог и поле «Схема» в настройках подключения.",
      "CONNECTION_SCHEMA",
      details,
    );
  if (name === "PERMISSION_DENIED" || name === "ACCESS_DENIED")
    return new ConnectionDiagnosticError(
      "Trino запретил выполнение запроса. Проверьте права пользователя на выбранный каталог и схему.",
      "CONNECTION_ACCESS",
      details,
    );
  return new ConnectionDiagnosticError(message, "ENGINE_QUERY_ERROR", details);
}
