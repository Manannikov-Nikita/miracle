import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer, type Server, type ServerOptions } from "node:https";
import type { RequestListener } from "node:http";

/** Disposable test-only certificates. No runtime files, accounts, or trust stores are touched. */
export function certificates() {
  const dir = mkdtempSync(join(tmpdir(), "miracle-tls-test-"));
  const run = (...args: string[]) =>
    execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  const read = (name: string) => readFileSync(join(dir, name), "utf8");
  run(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-days",
    "1",
    "-subj",
    "/CN=Miracle test CA",
  );
  for (const name of ["server", "client"]) {
    run(
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      name + ".key",
      "-out",
      name + ".csr",
      "-subj",
      "/CN=" + (name === "server" ? "localhost" : "test-client"),
    );
    writeFileSync(
      join(dir, "ext"),
      name === "server"
        ? "subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n"
        : "extendedKeyUsage=clientAuth\n",
    );
    run(
      "x509",
      "-req",
      "-in",
      name + ".csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      name + ".pem",
      "-days",
      "1",
      "-extfile",
      "ext",
    );
  }
  run(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "wrong.key",
    "-out",
    "wrong.pem",
    "-days",
    "1",
    "-subj",
    "/CN=Untrusted test CA",
  );
  const certs = {
    caCert: read("ca.pem"),
    serverCert: read("server.pem"),
    serverKey: read("server.key"),
    clientCert: read("client.pem"),
    clientKey: read("client.key"),
    wrongCa: read("wrong.pem"),
  };
  rmSync(dir, { recursive: true, force: true });
  return certs;
}
export async function tlsServer(
  certs: ReturnType<typeof certificates>,
  listener: RequestListener,
  options: ServerOptions = {},
) {
  const server = createServer(
    { key: certs.serverKey, cert: certs.serverCert, ...options },
    listener,
  );
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture port");
  return { server, url: "https://localhost:" + address.port };
}
export async function closeTls(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
export const compactResult = '["n"]\n["UInt64"]\n["9007199254740993"]\n';
