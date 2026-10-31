import { afterEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const run = promisify(execFile);
const loader = pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href;
const fixtures: { root: string; server: Server }[] = [];
afterEach(async () => {
  for (const { root, server } of fixtures.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "miracle HTTP QoS ")),
  );
  const runtime = join(root, "installation");
  const dataDir = join(root, ".miracle");
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    if (req.url === "/api/local/control") {
      expect(req.headers.authorization).toBe(`Bearer ${"a".repeat(64)}`);
      const action = JSON.parse(body).action;
      requests.push(action);
      res.setHeader("content-type", "application/json");
      if (action === "stop") res.once("finish", () => server.close());
      res.end(JSON.stringify({ ok: true }));
    } else if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("unfinished body");
    } else {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ value: "ok" }));
    }
  });
  fixtures.push({ root, server });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await mkdir(join(runtime, "run"), { recursive: true });
  const stateFile = join(
    runtime,
    "run",
    createHash("sha256").update(dataDir).digest("hex") + ".json",
  );
  await writeFile(
    stateFile,
    JSON.stringify({
      token: "a".repeat(64),
      port,
      pid: process.pid,
      dataDir,
      version: "0.2.1",
    }),
  );
  const preload = join(root, "qos-failure.mjs");
  await writeFile(
    preload,
    `import { Socket } from 'node:net';
// Initialize Node's shared builtin dispatcher before loading package undici.
await globalThis.fetch('data:text/plain,warm');
Socket.prototype.setTypeOfService = function () {
  throw Object.assign(new Error('setTypeOfService EINVAL'), { code: 'EINVAL', syscall: 'setTypeOfService', errno: -22 });
};
`,
  );
  const execute = async (file: string, args: string[] = []) =>
    await run(
      process.execPath,
      [
        "--import",
        pathToFileURL(preload).href,
        "--import",
        loader,
        file,
        ...args,
      ],
      {
        cwd: root,
        timeout: 10000,
        env: {
          ...process.env,
          MIRACLE_INSTALL_ROOT: runtime,
          MIRACLE_DATA_DIR: dataDir,
        },
      },
    );
  const script = async (code: string) => {
    const file = join(root, "check.mjs");
    await writeFile(file, code);
    return execute(file);
  };
  return { root, runtime, dataDir, port, requests, stateFile, script, execute };
}

it("CLI status and graceful stop survive unsupported socket QoS", async () => {
  const f = await fixture();
  const cli = resolve("src/server/cli.ts");
  const result = await f.execute(cli, ["status", "--json"]);
  expect(JSON.parse(result.stdout).status).toBe("running");
  expect((await f.execute(cli, ["stop"])).stdout).toMatch(/stopped/);
  expect(f.requests).toContain("stop");
  await expect(readFile(f.stateFile)).rejects.toMatchObject({ code: "ENOENT" });
}, 20000);

it("installer stops a registered old release without using the builtin HTTP dispatcher", async () => {
  const f = await fixture();
  const source = join(f.root, "payload");
  await mkdir(join(source, "runtime/bin"), { recursive: true });
  await mkdir(join(source, "dist/server/server"), { recursive: true });
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ version: "0.3.0", type: "module" }),
  );
  await symlink(process.execPath, join(source, "runtime/bin/node"));
  await writeFile(
    join(source, "dist/server/server/cli.js"),
    "console.log('0.3.0');\n",
  );
  const result = await f.execute(resolve("release/install.mjs"), [
    source,
    f.runtime,
    join(f.root, "bin"),
  ]);
  expect(result.stdout).toContain("Miracle 0.3.0 installed");
  expect(f.requests).toEqual(["status", "stop"]);
  expect(
    (await readFile(join(f.runtime, "current-version"), "utf8")).trim(),
  ).toBe("0.3.0");
}, 20000);

it("shared release HTTP transport owns its dispatcher and closes it after an unread response", async () => {
  const f = await fixture();
  const result =
    await f.script(`import { createHttpTransport } from ${JSON.stringify(pathToFileURL(resolve("src/server/http-transport.ts")).href)};
const transport = createHttpTransport();
const response = await transport.request('http://127.0.0.1:${f.port}/stream');
if (response.status !== 200) throw Error('HTTP failed');
await transport.close();
console.log('closed');
`);
  expect(result.stdout.trim()).toBe("closed");
}, 20000);

it("Trino without a custom CA survives unsupported socket QoS", async () => {
  const f = await fixture();
  const result =
    await f.script(`import { createTrinoTransport } from ${JSON.stringify(pathToFileURL(resolve("src/server/trinoTransport.ts")).href)};
const transport = createTrinoTransport({});
try {
  const response = await transport.request('http://127.0.0.1:${f.port}/v1/statement', { method: 'POST', body: 'SELECT 1', headers: {}, signal: AbortSignal.timeout(3000) });
  console.log((await response.json()).value);
} finally { await transport.close(); }
`);
  expect(result.stdout.trim()).toBe("ok");
}, 20000);
