export type ErrorContext = "connection" | "query" | "general";

export function describeError(
  error: unknown,
  options: { context?: ErrorContext; engine?: "clickhouse" | "trino" } = {},
): { title: string; hint: string; details: string } {
  // Read only the diagnostics supplied by the API, never arbitrary config fields.
  const value =
    error && typeof error === "object"
      ? (error as {
          message?: unknown;
          error?: unknown;
          details?: unknown;
          code?: unknown;
          status?: unknown;
        })
      : {};
  const message =
    typeof error === "string"
      ? error
      : typeof value.message === "string"
        ? value.message
        : typeof value.error === "string"
          ? value.error
          : "";
  const extra = typeof value.details === "string" ? value.details : "";
  const code = typeof value.code === "string" ? value.code : "";
  let details = extra.includes(message)
    ? extra
    : message.includes(extra)
      ? message
      : [message, extra].filter(Boolean).join("\n\n");
  if (code && !details.includes(code))
    details += `${details ? "\n\n" : ""}Код: ${code}`;
  const text = details || message;
  const result = (title: string, hint: string) => ({ title, hint, details });
  const syntaxError = () =>
    result(
      "Ошибка в синтаксисе SQL.",
      "Проверьте указанную в подробностях строку и исправьте SQL с учётом диалекта базы данных.",
    );
  const memoryError = () =>
    result(
      "Запрос превысил доступный объём памяти.",
      "Сократите объём данных до JOIN и группировок или уточните у администратора лимит памяти для запроса.",
    );
  const databaseHttp =
    options.context === "connection" ||
    /^CONNECTION_/.test(code) ||
    /\b(?:ClickHouse|Trino|Engine)\s+HTTP\b/i.test(text);

  if (
    /WORKSPACE_CHANGED|INSTANCE_CHANGED|рабочая область изменилась|экземпляр проекта изменился/i.test(
      text,
    )
  )
    return result(
      "Сервер открыл другую рабочую область.",
      "Сохраните нужные черновики и перезагрузите страницу, чтобы открыть текущий проект.",
    );
  if (
    /LOCAL_SESSION_EXPIRED|LOCAL_SESSION_STALE|локальная сессия завершена/i.test(
      text,
    )
  )
    return result(
      "Сессия Miracle завершилась.",
      "Перезагрузите страницу и повторите действие.",
    );
  if (
    /LOCAL_NETWORK_ERROR/.test(code) ||
    /^(?:Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed)$/i.test(
      message.trim(),
    )
  )
    return result(
      "Нет связи с Miracle.",
      "Убедитесь, что локальный сервер Miracle запущен, затем повторите действие.",
    );

  // Older validation responses may contain Zod's JSON array as the message.
  if (message.trim().startsWith("[")) {
    try {
      const issues: unknown = JSON.parse(message);
      const first = Array.isArray(issues) ? issues[0] : undefined;
      if (
        first &&
        Array.isArray(first.path) &&
        typeof first.message === "string"
      ) {
        const field = first.path.at(-1);
        if (field === "url")
          return result(
            "Некорректный адрес подключения.",
            "Укажите полный адрес с http:// или https:// и правильным портом.",
          );
        const labels: Record<string, string> = {
          name: "Название",
          username: "Пользователь",
          password: "Пароль",
          database: "База данных",
          catalog: "Каталог",
          schema: "Схема",
          requestTimeoutMs: "Таймаут",
          caCert: "CA-сертификат",
          clientCert: "Сертификат клиента",
          clientKey: "Закрытый ключ",
        };
        if (typeof field === "string" && labels[field])
          return result(
            "Параметры подключения заполнены некорректно.",
            `Проверьте поле «${labels[field]}». Требования указаны в подробностях ошибки.`,
          );
      }
    } catch {
      /* Keep unrecognized payloads intact in details. */
    }
  }

  // Engine headers are authoritative; the SQL excerpt may itself contain words
  // such as ECONNREFUSED or ENOTFOUND as identifiers or string literals.
  const clickhouseDiagnostic =
    /(?:^|\r?\n)(?:ClickHouse HTTP \d+:\s*)?Code:\s*(62|241)\.\s*DB::Exception:/i.exec(
      text,
    )?.[1];
  const trinoDiagnostic =
    /(?:^|\r?\n)Trino\r?\n(SYNTAX_ERROR|EXCEEDED_(?:LOCAL|GLOBAL)_MEMORY_LIMIT|MEMORY_LIMIT_EXCEEDED)(?:\r?\n|$)/i
      .exec(text)?.[1]
      ?.toUpperCase();
  if (clickhouseDiagnostic === "62" || trinoDiagnostic === "SYNTAX_ERROR")
    return syntaxError();
  if (
    clickhouseDiagnostic === "241" ||
    (trinoDiagnostic && trinoDiagnostic !== "SYNTAX_ERROR")
  )
    return memoryError();

  if (
    /CONNECTION_DNS|\bENOTFOUND\b|\bEAI_AGAIN\b|не удалось найти сервер/i.test(
      text,
    )
  )
    return result(
      "Не удалось найти сервер базы данных.",
      "Проверьте имя сервера в адресе подключения, доступ к сети и VPN, если он нужен.",
    );
  if (/CONNECTION_REFUSED|\bECONNREFUSED\b|connection refused/i.test(text))
    return result(
      "Сервер отклонил подключение.",
      "Проверьте адрес и порт: сервер базы данных должен быть запущен и принимать подключения на этом порту.",
    );
  if (
    /CONNECTION_TLS_HOSTNAME|ERR_TLS_CERT_ALTNAME_INVALID|hostname[^\n]*does not match|имя сервера[^\n]*не совпадает с сертификатом/i.test(
      text,
    )
  )
    return result(
      "Адрес сервера не совпадает с сертификатом.",
      "Используйте HTTPS-адрес с именем, указанным в сертификате сервера.",
    );
  if (/CERT_NOT_YET_VALID|certificate is not yet valid/i.test(text))
    return result(
      "Сертификат сервера ещё не действует.",
      "Проверьте срок действия сертификата и дату на компьютере.",
    );
  if (/CERT_HAS_EXPIRED|certificate has expired/i.test(text))
    return result(
      "Срок действия сертификата сервера истёк.",
      "Обновите сертификат сервера или обратитесь к администратору; также проверьте дату на компьютере.",
    );
  if (
    /CONNECTION_TLS_EXPIRED|сертификат[^\n]*просрочен или ещё не действует/i.test(
      text,
    )
  )
    return result(
      "Некорректный срок действия сертификата сервера.",
      "Проверьте сертификат сервера и дату на компьютере.",
    );
  if (
    /CONNECTION_TLS_CA|SELF_SIGNED_CERT|UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_UNTRUSTED|INVALID_CA|CERT_SIGNATURE_FAILURE|self[- ]signed certificate|unable to verify[^\n]*certificate|unable to get local issuer certificate|не удалось проверить сертификат TLS/i.test(
      text,
    )
  )
    return result(
      "Не удалось проверить сертификат сервера.",
      "Добавьте доверенный CA-сертификат или цепочку в формате PEM в настройках подключения.",
    );
  if (
    /CONNECTION_TLS_CLIENT_CERT|ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED|ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE|ERR_SSL_TLSV1_ALERT_UNKNOWN_CA/.test(
      text,
    )
  )
    return result(
      "Сервер не принял сертификат клиента.",
      "Проверьте сертификат клиента, соответствующий закрытый ключ и доверие сервера к их CA.",
    );
  if (
    /port[^\n]*is for clickhouse-client|must use port[^\n]*for HTTP|native protocol[^\n]*HTTP/i.test(
      text,
    )
  )
    return result(
      "Указан порт другого протокола.",
      options.engine === "trino"
        ? "Укажите HTTP(S)-адрес и порт координатора Trino."
        : "Укажите HTTP(S)-порт ClickHouse из настроек сервера; порт нативного протокола здесь не подходит.",
    );
  if (
    /CONNECTION_TLS_PROTOCOL|ERR_SSL_WRONG_VERSION_NUMBER|wrong version number|plain HTTP request was sent to HTTPS port/i.test(
      text,
    )
  )
    return result(
      "Не удалось согласовать HTTPS-подключение.",
      "Проверьте, что http:// или https:// в адресе соответствует протоколу сервера и выбранному порту.",
    );
  if (/отменён или истёк таймаут/i.test(text))
    return result(
      "Запрос остановлен.",
      "Если вы не отменяли запрос, проверьте доступность сервера и таймаут, затем повторите запрос.",
    );
  if (
    /CONNECTION_TIMEOUT|\bETIMEDOUT\b|\bESOCKETTIMEDOUT\b|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT|TIMEOUT_EXCEEDED|timed? out|timeout exceeded|истёк таймаут/i.test(
      text,
    )
  )
    return result(
      "Сервер не ответил вовремя.",
      options.context === "query"
        ? "Сократите объём данных в запросе или проверьте таймаут подключения и нагрузку на сервер."
        : "Проверьте доступность сервера, сеть и VPN. Если сервер отвечает медленно, проверьте таймаут подключения.",
    );
  if (/CONNECTION_RESET|\bECONNRESET\b|\bEPIPE\b|UND_ERR_SOCKET/.test(text))
    return result(
      "Соединение с сервером прервано.",
      "Проверьте доступность сервера, прокси и сети, затем повторите действие.",
    );
  if (code === "CONNECTION_NETWORK")
    return result(
      "Не удалось подключиться к базе данных.",
      "Проверьте адрес, доступность сети и настройки TLS; точная причина подключения не определена.",
    );

  if (
    /CONNECTION_AUTH|AUTHENTICATION_FAILED|authentication failed|invalid (?:user(?:name)? or )?password|password is incorrect|incorrect password|неверн(?:ый|ое) (?:пароль|имя пользователя)/i.test(
      text,
    )
  )
    return result(
      "Сервер не принял имя пользователя или пароль.",
      "Проверьте имя пользователя и пароль в настройках подключения. Если используется вход по сертификату, проверьте сертификат клиента.",
    );
  if (
    databaseHttp &&
    (value.status === 401 ||
      /\bHTTP\s*401\b|\b401\s+Unauthorized\b/i.test(text))
  )
    return result(
      "Сервер требует авторизацию.",
      "Проверьте способ входа, имя пользователя и пароль в настройках подключения.",
    );
  if (
    code === "CONNECTION_ACCESS" ||
    /(?:^|\r?\n)Trino\r?\n(?:PERMISSION_DENIED|ACCESS_DENIED)(?:\r?\n|$)/i.test(
      text,
    ) ||
    (databaseHttp &&
      (value.status === 403 ||
        /\bHTTP\s*403\b|\b403\s+Forbidden\b|\bACCESS_DENIED\b|access denied|permission denied for (?:schema|table|database)|недостаточно прав/i.test(
          text,
        )))
  )
    return result(
      "Сервер запретил доступ.",
      "Проверьте права пользователя на подключение и нужные данные; при необходимости обратитесь к администратору.",
    );
  if (
    /CONNECTION_DATABASE|UNKNOWN_DATABASE|DATABASE_NOT_FOUND|(?:database[^\n]*does not exist)|unknown database/i.test(
      text,
    )
  )
    return result(
      "База данных не найдена.",
      "Проверьте название базы в подключении или запросе и выберите существующую базу данных.",
    );
  if (
    /CONNECTION_CATALOG|CATALOG_NOT_FOUND|catalog[^\n]*(?:does not exist|not found)|unknown catalog/i.test(
      text,
    )
  )
    return result(
      "Каталог Trino не найден.",
      "Проверьте каталог в настройках подключения или запросе и выберите существующий каталог.",
    );
  if (
    /CONNECTION_SCHEMA|SCHEMA_NOT_FOUND|schema[^\n]*(?:does not exist|not found)|unknown schema/i.test(
      text,
    )
  )
    return result(
      "Схема не найдена.",
      "Проверьте название схемы и выбранный каталог в подключении или запросе.",
    );
  if (
    /MEMORY_LIMIT_EXCEEDED|EXCEEDED_(?:LOCAL|GLOBAL)_MEMORY_LIMIT|memory limit[^\n]*exceeded|exceeded[^\n]*memory limit/i.test(
      text,
    )
  )
    return memoryError();
  if (
    /SYNTAX_ERROR|syntax error|line \d+:\d+:[^\n]*mismatched input/i.test(text)
  )
    return syntaxError();
  if (code === "CONNECTION_ENDPOINT")
    return result(
      "HTTP-адрес сервера не найден.",
      "Проверьте URL, порт и путь HTTP-интерфейса базы данных.",
    );
  if (code === "CONNECTION_REDIRECT")
    return result(
      "Сервер перенаправляет подключение.",
      "Укажите конечный HTTP(S)-адрес сервера в настройках подключения.",
    );
  if (code === "CONNECTION_HTTP")
    return result(
      "Сервер базы данных вернул ошибку.",
      "Проверьте состояние сервера и сообщение в подробностях ошибки.",
    );

  const shortMessage = message.trim();
  if (
    shortMessage.length <= 200 &&
    /[А-Яа-яЁё]/.test(shortMessage) &&
    !/[\n{}<>]|DB::Exception|Stack trace/.test(shortMessage)
  ) {
    const instruction =
      /^(.+?[.!?])\s+((?:Проверьте|Укажите|Выберите|Добавьте|Загрузите|Сохраните|Перезагрузите|Повторите|Откройте|Обновите|Разрешите|Настройте|Исправьте|Дождитесь|Обратитесь)(?=\s).+)$/u.exec(
        shortMessage,
      );
    if (instruction && instruction[1].length <= 120)
      return result(instruction[1], instruction[2]);
    if (shortMessage.length <= 120) return result(shortMessage, "");
  }
  return result(
    options.context === "connection"
      ? "Не удалось проверить подключение."
      : options.context === "query"
        ? "Не удалось выполнить запрос."
        : "Не удалось выполнить действие.",
    "Откройте подробности ошибки, проверьте указанные там параметры и повторите действие.",
  );
}
