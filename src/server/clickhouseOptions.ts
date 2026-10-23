import { X509Certificate, createPrivateKey } from "node:crypto";
import { z } from "zod";
import {
  CLICKHOUSE_CERT_MAX_BYTES,
  CLICKHOUSE_SETTING_FIELDS,
} from "../shared/clickhouse-options.js";
import type {
  ClickHouseOptions,
  ClickHousePublicOptions,
  ConnectionInput,
} from "../shared/types.js";

const material = z
  .string()
  .max(CLICKHOUSE_CERT_MAX_BYTES)
  .refine(
    (v) => Buffer.byteLength(v) <= CLICKHOUSE_CERT_MAX_BYTES,
    "Сертификат или ключ слишком велик",
  )
  .nullable()
  .optional();
export const clickhouseOptionsSchema = z
  .object({
    requestTimeoutMs: z.number().int().min(1000).max(600000).optional(),
    compression: z.boolean().optional(),
    settings: z
      .record(z.string(), z.string().max(200))
      .superRefine((settings, ctx) => {
        for (const [name, value] of Object.entries(settings)) {
          const field = CLICKHOUSE_SETTING_FIELDS.find((f) => f.name === name);
          let valid = !!field;
          if (field?.kind === "integer")
            valid =
              /^\d+$/.test(value) &&
              Number.isSafeInteger(Number(value)) &&
              Number(value) >= field.min &&
              Number(value) <= field.max;
          if (field?.kind === "boolean") valid = value === "0" || value === "1";
          if (field?.kind === "timezone") {
            try {
              new Intl.DateTimeFormat("en", { timeZone: value });
              valid = !!value;
            } catch {
              valid = false;
            }
          }
          if (!valid)
            ctx.addIssue({
              code: "custom",
              path: [name],
              message: "Недопустимая настройка ClickHouse",
            });
        }
      })
      .optional(),
    tls: z
      .object({
        caCert: material,
        clientCert: material,
        clientKey: material,
        certificateAuth: z.boolean().optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()
  .nullable();

export function mergeClickHouseOptions(
  old: ClickHouseOptions | null | undefined,
  patch: ClickHouseOptions | null | undefined,
): ClickHouseOptions | undefined {
  if (patch === undefined) return old || undefined;
  if (patch === null) return undefined;
  const next = { ...old, ...patch };
  if (patch.tls === undefined) next.tls = old?.tls;
  else if (patch.tls !== null) next.tls = { ...old?.tls, ...patch.tls };
  return next;
}

export function validateClickHouseConnection(c: ConnectionInput) {
  const options = clickhouseOptionsSchema.optional().parse(c.clickhouse);
  if (c.engine !== "clickhouse" && options)
    throw new Error("Параметры ClickHouse недоступны для Trino");
  const tls = options?.tls;
  if (!tls) return;
  if (
    (tls.caCert || tls.clientCert || tls.clientKey || tls.certificateAuth) &&
    new URL(c.url).protocol !== "https:"
  )
    throw new Error("Сертификаты TLS требуют URL https://");
  if (
    tls.certificateAuth &&
    (!tls.clientCert || !tls.clientKey || !c.username.trim())
  )
    throw new Error(
      "Для входа по сертификату нужны имя пользователя, сертификат и закрытый ключ",
    );
  if (!!tls.clientCert !== !!tls.clientKey)
    throw new Error("Для mTLS нужны сертификат клиента и закрытый ключ вместе");
  try {
    if (tls.caCert) {
      const certs = tls.caCert.match(
        /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
      );
      if (
        !certs?.length ||
        tls.caCert
          .replace(
            /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
            "",
          )
          .trim()
      )
        throw new Error();
      for (const cert of certs) new X509Certificate(cert);
    }
    if (tls.clientCert && tls.clientKey) {
      const certs = tls.clientCert.match(
        /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
      );
      if (
        !certs?.length ||
        tls.clientCert
          .replace(
            /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
            "",
          )
          .trim()
      )
        throw new Error();
      for (const chainCert of certs) new X509Certificate(chainCert);
      if (
        !/^\s*-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY)-----[\s\S]*-----END \1-----\s*$/.test(
          tls.clientKey,
        )
      )
        throw new Error();
      const cert = new X509Certificate(certs[0]);
      if (!cert.checkPrivateKey(createPrivateKey(tls.clientKey)))
        throw new Error();
    }
  } catch {
    throw new Error(
      "Некорректный сертификат TLS или закрытый ключ; проверьте формат PEM и соответствие пары",
    );
  }
}

export function publicClickHouseOptions(
  options: ClickHouseOptions | null | undefined,
): ClickHousePublicOptions | undefined {
  if (!options) return undefined;
  return {
    requestTimeoutMs: options.requestTimeoutMs,
    compression: options.compression,
    settings: options.settings,
    ...(options.tls
      ? {
          tls: {
            certificateAuth: options.tls.certificateAuth,
            hasCaCert: !!options.tls.caCert,
            hasClientCert: !!options.tls.clientCert,
            hasClientKey: !!options.tls.clientKey,
          },
        }
      : {}),
  };
}
