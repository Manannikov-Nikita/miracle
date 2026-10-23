/** Explicitly supported settings; wire format and application limits are not user-overridable. */
export const CLICKHOUSE_SETTING_FIELDS = [
  {
    name: "max_threads",
    label: "Потоки запроса",
    kind: "integer",
    min: 1,
    max: 256,
  },
  {
    name: "max_memory_usage",
    label: "Память запроса, байт",
    kind: "integer",
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  },
  {
    name: "max_bytes_before_external_group_by",
    label: "Сброс GROUP BY на диск, байт",
    kind: "integer",
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  },
  {
    name: "max_bytes_before_external_sort",
    label: "Сброс сортировки на диск, байт",
    kind: "integer",
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  },
  { name: "join_use_nulls", label: "NULL в JOIN", kind: "boolean" },
  { name: "session_timezone", label: "Часовой пояс", kind: "timezone" },
] as const;
export const CLICKHOUSE_CERT_MAX_BYTES = 128 * 1024;
export const CLICKHOUSE_REQUEST_TIMEOUT_DEFAULT = 120_000;
