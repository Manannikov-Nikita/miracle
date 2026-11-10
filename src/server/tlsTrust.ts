import { getCACertificates } from "node:tls";

/** OS discovery honors Node's platform trust rules. Never import peer chains or
 * change process trust: a manually supplied CA applies only to its connection. */
export function connectionTlsOptions(caCert?: string | null) {
  return {
    ca: caCert || [
      ...new Set([
        ...getCACertificates("default"),
        ...getCACertificates("system"),
      ]),
    ],
    rejectUnauthorized: true,
  };
}
