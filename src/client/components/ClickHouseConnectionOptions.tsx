import { useEffect, useRef, useState } from "react";
import { Trash } from "@phosphor-icons/react";
import type {
  ClickHouseOptions,
  ClickHousePublicOptions,
} from "../../shared/types";
import {
  CLICKHOUSE_CERT_MAX_BYTES,
  CLICKHOUSE_REQUEST_TIMEOUT_DEFAULT,
  CLICKHOUSE_SETTING_FIELDS,
} from "../../shared/clickhouse-options";
import { Select } from "./Select";
import { ErrorBox, IconButton } from "./UI";

type TLSField = "caCert" | "clientCert" | "clientKey";
const certificates: { field: TLSField; title: string; accept: string }[] = [
  {
    field: "caCert",
    title: "Корневой сертификат CA",
    accept: ".pem,.crt,.cer",
  },
  {
    field: "clientCert",
    title: "Сертификат клиента",
    accept: ".pem,.crt,.cer",
  },
  { field: "clientKey", title: "Закрытый ключ клиента", accept: ".pem,.key" },
];
const presenceKey = {
  caCert: "hasCaCert",
  clientCert: "hasClientCert",
  clientKey: "hasClientKey",
} as const;

export function connectionUsesHttps(url: string) {
  return /^https:\/\//i.test(url.trim());
}
export function connectionProtocol(url: string, secure: boolean) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
    const defaultPort =
      !parsed.port || parsed.port === "8123" || parsed.port === "8443";
    parsed.protocol = secure ? "https:" : "http:";
    if (defaultPort) parsed.port = secure ? "8443" : "8123";
    return parsed
      .toString()
      .replace(
        /\/$/,
        parsed.pathname === "/" && !parsed.search && !parsed.hash ? "" : "/",
      );
  } catch {
    return `${secure ? "https" : "http"}://localhost:${secure ? "8443" : "8123"}`;
  }
}
export function certificatePresent(
  options: ClickHouseOptions | null | undefined,
  saved: ClickHousePublicOptions | undefined,
  field: TLSField,
) {
  if (options === null || options?.tls === null) return false;
  const value = options?.tls?.[field];
  return value === undefined
    ? Boolean(saved?.tls?.[presenceKey[field]])
    : Boolean(value);
}
export function clickhouseFormError(
  url: string,
  options: ClickHouseOptions | null | undefined,
  saved?: ClickHousePublicOptions,
) {
  const has = (field: TLSField) => certificatePresent(options, saved, field);
  if (!connectionUsesHttps(url) && certificates.some(({ field }) => has(field)))
    return "Сертификаты требуют HTTPS. Включите SSL / TLS или явно удалите сертификаты.";
  if (
    options?.tls?.certificateAuth &&
    (!has("clientCert") || !has("clientKey"))
  )
    return "Для входа по сертификату выберите сертификат клиента и закрытый ключ.";
  if (has("clientCert") !== has("clientKey"))
    return "Для mTLS нужны и сертификат клиента, и его закрытый ключ.";
  return "";
}

export default function ClickHouseConnectionOptions({
  url,
  options,
  saved,
  onUrlChange,
  onChange,
  disabled,
  onPendingChange,
}: {
  url: string;
  options: ClickHouseOptions | null | undefined;
  saved?: ClickHousePublicOptions;
  onUrlChange: (url: string) => void;
  onChange: (options: ClickHouseOptions) => void;
  disabled?: boolean;
  onPendingChange: (pending: boolean) => void;
}) {
  const [uploadError, setUploadError] = useState("");
  const [names, setNames] = useState<Partial<Record<TLSField, string>>>({});
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);
  const currentOptions = useRef(options);
  currentOptions.current = options;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const secure = connectionUsesHttps(url);
  const settings = options?.settings ?? {};
  const available = CLICKHOUSE_SETTING_FIELDS.filter(
    (field) => !(field.name in settings),
  );
  const update = (patch: Partial<ClickHouseOptions>) =>
    onChange({ ...currentOptions.current, ...patch });
  const currentTls = () =>
    currentOptions.current === null || currentOptions.current?.tls === null
      ? {
          caCert: null,
          clientCert: null,
          clientKey: null,
          certificateAuth: false,
        }
      : currentOptions.current?.tls;
  const changeCertificate = (field: TLSField, value: string | null) =>
    update({ tls: { ...currentTls(), [field]: value } });
  const hasCertificates = certificates.some(({ field }) =>
    certificatePresent(options, saved, field),
  );
  async function upload(field: TLSField, file: File | undefined) {
    if (!file) return;
    setUploadError("");
    if (file.size > CLICKHOUSE_CERT_MAX_BYTES) {
      setUploadError(
        "Файл сертификата или ключа должен быть не больше 128 КиБ.",
      );
      return;
    }
    setLoading(true);
    onPendingChange(true);
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer(),
      );
      if (!content.trim() || !content.includes("-----BEGIN "))
        throw new Error("format");
      if (!mounted.current) return;
      changeCertificate(field, content);
      setNames((current) => ({ ...current, [field]: file.name }));
    } catch {
      if (mounted.current)
        setUploadError(
          "Не удалось прочитать PEM-файл. Выберите текстовый сертификат или ключ в UTF-8.",
        );
    } finally {
      if (mounted.current) {
        setLoading(false);
        onPendingChange(false);
      }
    }
  }
  return (
    <>
      <details
        className="connection-options"
        open={secure || hasCertificates || undefined}
      >
        <summary>
          SSL / TLS <span className="muted">{secure ? "HTTPS" : "HTTP"}</span>
        </summary>
        <div className="connection-options-body">
          <label className="connection-checkbox">
            <input
              type="checkbox"
              checked={secure}
              disabled={disabled || loading}
              onChange={(event) =>
                onUrlChange(connectionProtocol(url, event.target.checked))
              }
            />
            Использовать HTTPS
          </label>
          <p className="muted connection-option-hint">
            HTTPS обычно использует порт 8443. Сертификат сервера проверяется
            всегда. Для публичного сертификата файл CA не нужен.
          </p>
          <fieldset
            className="connection-certificates"
            disabled={disabled || loading}
          >
            <legend className="connection-certificates-legend">
              Сертификаты TLS
            </legend>
            {certificates.map(({ field, title, accept }) => {
              const present = certificatePresent(options, saved, field);
              return (
                <div className="connection-certificate" key={field}>
                  <div>
                    <strong>{title}</strong>
                    <span className="muted">
                      {present
                        ? names[field] || "Сохранён"
                        : options?.tls === null ||
                            options?.tls?.[field] === null
                          ? "Будет удалён"
                          : "Не выбран"}
                    </span>
                  </div>
                  <label className="button small connection-file-picker">
                    {present ? "Заменить" : "Выбрать файл"}
                    <input
                      aria-label={title}
                      type="file"
                      accept={accept}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        void upload(field, file);
                      }}
                    />
                  </label>
                  {present && (
                    <IconButton
                      label={`Удалить: ${title}`}
                      onClick={() => {
                        changeCertificate(field, null);
                        setNames((current) => ({
                          ...current,
                          [field]: undefined,
                        }));
                      }}
                    >
                      <Trash size={15} />
                    </IconButton>
                  )}
                </div>
              );
            })}
          </fieldset>
          <label className="connection-checkbox">
            <input
              type="checkbox"
              checked={options?.tls?.certificateAuth ?? false}
              disabled={disabled || loading}
              onChange={(event) =>
                update({
                  tls: {
                    ...currentTls(),
                    certificateAuth: event.target.checked,
                  },
                })
              }
            />
            Вход в ClickHouse по сертификату
          </label>
          <p className="muted connection-option-hint">
            Включите, если пользователь ClickHouse настроен на вход по
            сертификату. Имя пользователя сохранится, пароль не используется.
            Для mTLS на прокси без входа в ClickHouse оставьте выключенным.
          </p>
          <p className="muted connection-option-hint">
            PEM, до 128 КиБ на файл. Для mTLS выберите сертификат клиента и
            закрытый ключ без пароля. Материал сертификатов хранится на сервере
            и не возвращается в форму.
          </p>
          {hasCertificates && (
            <button
              type="button"
              className="button small"
              disabled={disabled || loading}
              onClick={() => {
                update({ tls: null });
                setNames({});
              }}
            >
              Удалить все сертификаты
            </button>
          )}
          {loading && (
            <span className="muted" role="status">
              Чтение файла…
            </span>
          )}
          {uploadError && <ErrorBox>{uploadError}</ErrorBox>}
        </div>
      </details>
      <details className="connection-options">
        <summary>
          Параметры{" "}
          <span className="muted">
            {Object.keys(settings).length
              ? `Настроено: ${Object.keys(settings).length}`
              : "Дополнительно"}
          </span>
        </summary>
        <div className="connection-options-body">
          <label>
            Таймаут HTTP-запроса, секунд
            <input
              className="connection-timeout"
              type="number"
              min={1}
              max={600}
              step={0.001}
              required
              value={
                (options?.requestTimeoutMs ??
                  CLICKHOUSE_REQUEST_TIMEOUT_DEFAULT) / 1000
              }
              disabled={disabled}
              onChange={(event) =>
                update({ requestTimeoutMs: Number(event.target.value) * 1000 })
              }
            />
            <small className="muted">
              От 1 до 600 секунд. Не увеличивает общий лимит запроса Miracle.
            </small>
          </label>
          <label className="connection-checkbox">
            <input
              type="checkbox"
              checked={options?.compression ?? false}
              disabled={disabled}
              onChange={(event) =>
                update({ compression: event.target.checked })
              }
            />
            Сжимать HTTP-ответы
          </label>
          <div className="connection-settings">
            {Object.entries(settings).map(([name, value]) => {
              const field = CLICKHOUSE_SETTING_FIELDS.find(
                (item) => item.name === name,
              );
              return (
                <div className="connection-setting" key={name}>
                  <label>
                    <span>{name}</span>
                    <input
                      aria-label={`Значение ${name}`}
                      required
                      value={value}
                      disabled={disabled}
                      onChange={(event) =>
                        update({
                          settings: { ...settings, [name]: event.target.value },
                        })
                      }
                    />
                    <small className="muted">
                      {field?.label ?? "Параметр ClickHouse"}
                      {field?.kind === "boolean" ? " · 0 или 1" : ""}
                    </small>
                  </label>
                  <IconButton
                    label={`Удалить параметр ${name}`}
                    disabled={disabled}
                    onClick={() => {
                      const next = { ...settings };
                      delete next[name];
                      update({ settings: next });
                    }}
                  >
                    <Trash size={15} />
                  </IconButton>
                </div>
              );
            })}
            {available.length > 0 && (
              <Select
                aria-label="Добавить параметр ClickHouse"
                value=""
                placeholder="Добавить параметр ClickHouse"
                disabled={disabled}
                options={available.map((field) => ({
                  value: field.name,
                  label: `${field.name} · ${field.label}`,
                }))}
                onValueChange={(name) =>
                  update({
                    settings: {
                      ...settings,
                      [name]:
                        name === "session_timezone"
                          ? "UTC"
                          : name === "join_use_nulls"
                            ? "0"
                            : "1",
                    },
                  })
                }
              />
            )}
          </div>
        </div>
      </details>
    </>
  );
}
