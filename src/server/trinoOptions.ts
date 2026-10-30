import { X509Certificate } from "node:crypto";
import { z } from "zod";
import { TRINO_CERT_MAX_BYTES } from "../shared/trino-options.js";
import type {
  ConnectionInput,
  TrinoOptions,
  TrinoPublicOptions,
} from "../shared/types.js";

export const trinoOptionsSchema = z
  .object({
    tls: z
      .object({
        caCert: z
          .string()
          .min(1, "Пустой CA-сертификат Trino")
          .max(TRINO_CERT_MAX_BYTES, "CA-сертификат Trino слишком велик")
          .refine(
            (value) => Buffer.byteLength(value) <= TRINO_CERT_MAX_BYTES,
            "CA-сертификат Trino слишком велик",
          )
          .nullable()
          .optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()
  .nullable();

export function mergeTrinoOptions(
  old: TrinoOptions | null | undefined,
  patch: TrinoOptions | null | undefined,
): TrinoOptions | undefined {
  if (patch === undefined) return old || undefined;
  if (patch === null) return undefined;
  const next = { ...old, ...patch };
  if (patch.tls === undefined) next.tls = old?.tls;
  else if (patch.tls !== null) next.tls = { ...old?.tls, ...patch.tls };
  return next;
}

export function validateTrinoConnection(connection: ConnectionInput) {
  const options = trinoOptionsSchema.optional().parse(connection.trino);
  if (connection.engine !== "trino" && options)
    throw new Error("Параметры Trino недоступны для ClickHouse");
  const ca = options?.tls?.caCert;
  if (!ca) return;
  if (new URL(connection.url).protocol !== "https:")
    throw new Error("CA-сертификат Trino требует URL https://");
  try {
    const pattern =
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
    const certificates = ca.match(pattern);
    if (!certificates?.length || ca.replace(pattern, "").trim())
      throw new Error();
    for (const certificate of certificates) new X509Certificate(certificate);
  } catch {
    throw new Error(
      "Некорректный CA-сертификат Trino; выберите сертификат или цепочку в формате PEM",
    );
  }
}

export function publicTrinoOptions(
  options: TrinoOptions | null | undefined,
): TrinoPublicOptions | undefined {
  if (!options) return undefined;
  return options.tls ? { tls: { hasCaCert: !!options.tls.caCert } } : {};
}
