import { useEffect, useRef, useState } from "react";
import { Trash } from "@phosphor-icons/react";
import type { TrinoOptions, TrinoPublicOptions } from "../../shared/types";
import { TRINO_CERT_MAX_BYTES } from "../../shared/trino-options";
import { ErrorBox, IconButton } from "./UI";

function usesHttps(url: string) {
  return /^https:\/\//i.test(url.trim());
}

function connectionProtocol(url: string, secure: boolean) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return url;
    // Trino coordinators and gateways use different ports. Keep the supplied
    // port rather than assuming ClickHouse's 8123/8443 convention.
    parsed.protocol = secure ? "https:" : "http:";
    return parsed
      .toString()
      .replace(
        /\/$/,
        parsed.pathname === "/" && !parsed.search && !parsed.hash ? "" : "/",
      );
  } catch {
    return `${secure ? "https" : "http"}://localhost:8080`;
  }
}

function certificatePresent(
  options: TrinoOptions | null | undefined,
  saved?: TrinoPublicOptions,
) {
  if (options === null || options?.tls === null) return false;
  const certificate = options?.tls?.caCert;
  return certificate === undefined
    ? Boolean(saved?.tls?.hasCaCert)
    : Boolean(certificate);
}

export function trinoFormError(
  url: string,
  options: TrinoOptions | null | undefined,
  saved?: TrinoPublicOptions,
) {
  return !usesHttps(url) && certificatePresent(options, saved)
    ? "Сертификат CA требует HTTPS. Включите SSL / TLS или явно удалите сертификат."
    : "";
}

export default function TrinoConnectionOptions({
  url,
  options,
  saved,
  onUrlChange,
  onChange,
  disabled,
  onPendingChange,
}: {
  url: string;
  options: TrinoOptions | null | undefined;
  saved?: TrinoPublicOptions;
  onUrlChange: (url: string) => void;
  onChange: (options: TrinoOptions) => void;
  disabled?: boolean;
  onPendingChange: (pending: boolean) => void;
}) {
  const [uploadError, setUploadError] = useState("");
  const [filename, setFilename] = useState("");
  const [loading, setLoading] = useState(false);
  const uploadGeneration = useRef(0);
  const mounted = useRef(true);
  const currentOptions = useRef(options);
  currentOptions.current = options;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      uploadGeneration.current++;
    };
  }, []);
  const secure = usesHttps(url);
  const present = certificatePresent(options, saved);
  const changeCertificate = (caCert: string | null) =>
    onChange({ ...currentOptions.current, tls: { caCert } });

  async function upload(file: File | undefined) {
    if (!file) return;
    const generation = ++uploadGeneration.current;
    setUploadError("");
    if (file.size > TRINO_CERT_MAX_BYTES) {
      setUploadError("Файл сертификата должен быть не больше 128 КиБ.");
      setLoading(false);
      onPendingChange(false);
      return;
    }
    setLoading(true);
    onPendingChange(true);
    try {
      const bytes = await file.arrayBuffer();
      if (bytes.byteLength > TRINO_CERT_MAX_BYTES) throw new Error("size");
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const certificates =
        /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
      if (
        !content.match(certificates)?.length ||
        content.replace(certificates, "").trim()
      )
        throw new Error("format");
      if (!mounted.current || generation !== uploadGeneration.current) return;
      changeCertificate(content);
      setFilename(file.name);
    } catch {
      if (mounted.current && generation === uploadGeneration.current)
        setUploadError(
          "Не удалось прочитать PEM-файл. Выберите текстовый сертификат CA или цепочку сертификатов в UTF-8, до 128 КиБ.",
        );
    } finally {
      if (mounted.current && generation === uploadGeneration.current) {
        setLoading(false);
        onPendingChange(false);
      }
    }
  }

  return (
    <details
      className="connection-options"
      open={secure || present || undefined}
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
          Укажите HTTPS-адрес и порт вашего Trino или шлюза. Для корпоративного
          центра сертификации выберите его CA или цепочку CA. Для публичного
          сертификата файл обычно не нужен.
        </p>
        <fieldset
          className="connection-certificates"
          disabled={disabled || loading}
        >
          <legend className="connection-certificates-legend">
            Сертификаты TLS
          </legend>
          <div className="connection-certificate">
            <div>
              <strong>Корневой сертификат CA</strong>
              <span className="muted">
                {present
                  ? filename || "Сохранён"
                  : options === null ||
                      options?.tls === null ||
                      options?.tls?.caCert === null
                    ? "Будет удалён"
                    : "Не выбран"}
              </span>
            </div>
            <label className="button small connection-file-picker">
              {present ? "Заменить" : "Выбрать файл"}
              <input
                aria-label="Корневой сертификат CA"
                type="file"
                accept=".pem,.crt,.cer"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  void upload(file);
                }}
              />
            </label>
            {present && (
              <IconButton
                label="Удалить: Корневой сертификат CA"
                onClick={() => {
                  uploadGeneration.current++;
                  changeCertificate(null);
                  setFilename("");
                  setUploadError("");
                }}
              >
                <Trash size={15} />
              </IconButton>
            )}
          </div>
        </fieldset>
        <p className="muted connection-option-hint">
          PEM, до 128 КиБ. Сертификат сервера и его имя проверяются всегда. CA
          действует только для этого подключения, хранится зашифрованно и не
          возвращается в форму.
        </p>
        {loading && (
          <span className="muted" role="status">
            Чтение файла…
          </span>
        )}
        {uploadError && <ErrorBox>{uploadError}</ErrorBox>}
      </div>
    </details>
  );
}
