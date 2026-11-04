/** Only the supported JDBC subset is imported; unsupported options never disappear silently. */
export interface ImportedTrinoUrl {
  url: string;
  username?: string;
  password?: string;
  catalog?: string;
  schema?: string;
  externalAuthentication: boolean;
}

export function parseTrinoJdbcUrl(input: string): ImportedTrinoUrl {
  const value = input.trim();
  if (value.length > 16384 || !/^jdbc:trino:\/\//i.test(value))
    throw new Error(
      "Ожидается JDBC-адрес вида jdbc:trino://host:port/catalog/schema",
    );
  const address = value.slice("jdbc:trino:".length);
  if (/[\\\u0000-\u0020\u007f]/.test(address))
    throw new Error("Некорректный JDBC-адрес Trino");
  let parsed: URL;
  try {
    parsed = new URL(`http:${address}`);
  } catch {
    throw new Error("Некорректный JDBC-адрес Trino");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    address.includes("#")
  )
    throw new Error(
      "Пользователь и пароль задаются параметрами JDBC; фрагмент адреса не поддерживается",
    );

  const supported = new Set([
    "SSL",
    "SSLVerification",
    "externalAuthentication",
    "externalAuthenticationTokenCache",
    "user",
    "password",
  ]);
  const params = parsed.searchParams;
  for (const key of params.keys()) {
    if (!supported.has(key))
      throw new Error(
        "JDBC-адрес содержит неподдерживаемые параметры. Перенесите необходимые настройки в поля подключения",
      );
    if (params.getAll(key).length !== 1)
      throw new Error("Параметры JDBC не должны повторяться");
  }
  const boolean = (key: string) => {
    const raw = params.get(key);
    if (raw === null) return false;
    if (!/^(true|false)$/i.test(raw))
      throw new Error("Логические параметры JDBC принимают true или false");
    return raw.toLowerCase() === "true";
  };
  const ssl = boolean("SSL");
  const externalAuthentication = boolean("externalAuthentication");
  if (params.has("SSLVerification") && params.get("SSLVerification") !== "FULL")
    throw new Error(
      "Miracle поддерживает только полную проверку TLS: SSLVerification=FULL",
    );
  if (params.has("SSLVerification") && !ssl)
    throw new Error("SSLVerification требует SSL=true");
  if (externalAuthentication && !ssl)
    throw new Error("Внешняя авторизация Trino требует SSL=true");
  if (
    params.has("externalAuthenticationTokenCache") &&
    params.get("externalAuthenticationTokenCache") !== "MEMORY"
  )
    throw new Error(
      "Токены внешней авторизации хранятся только в памяти: externalAuthenticationTokenCache=MEMORY",
    );

  // Inspect the original path: URL canonicalization would erase dot segments.
  const rawPath = address.split(/[?#]/, 1)[0]!.replace(/^\/\/[^/]+/, "");
  let segments: string[];
  try {
    segments = rawPath.replace(/^\//, "").split("/").map(decodeURIComponent);
  } catch {
    throw new Error("Некорректное кодирование каталога или схемы JDBC");
  }
  if (segments.length === 1 && segments[0] === "") segments = [];
  if (
    segments.length > 2 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /[/\\\u0000-\u001f\u007f]/.test(segment),
    )
  )
    throw new Error(
      "Путь JDBC должен содержать каталог и необязательную схему",
    );
  const result: ImportedTrinoUrl = {
    // Parse the original authority again so an explicit :80 survives HTTPS.
    url: new URL(`${ssl ? "https:" : "http:"}${address}`).origin,
    externalAuthentication,
  };
  if (segments[0]) result.catalog = segments[0];
  if (segments[1]) result.schema = segments[1];
  if (params.has("user")) result.username = params.get("user")!;
  if (params.has("password")) result.password = params.get("password")!;
  return result;
}
