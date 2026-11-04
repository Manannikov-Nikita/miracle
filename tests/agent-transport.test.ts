import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { AgentTransport } from "../src/server/agents/transport.js";

const transports: AgentTransport[] = [];
const descendants: number[] = [];
async function runningTransport(withDescendant = false) {
  const transport = new AgentTransport(
    process.execPath,
    [
      "-e",
      `
      process.stdin.on('data', () => process.exit(0));
      ${
        withDescendant
          ? "const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(child.pid);"
          : "console.log('ready');"
      }
    `,
    ],
    process.cwd(),
    process.env,
  );
  transports.push(transport);
  const [output] = await once(transport.child.stdout, "data");
  if (withDescendant) descendants.push(Number(String(output).trim()));
  return transport;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const transport of transports.splice(0)) {
    transport.child.kill("SIGKILL");
    await transport.closed;
  }
  for (const pid of descendants.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error: any) {
      if (error.code !== "ESRCH") throw error;
    }
  }
});
const permissionError = () =>
  Object.assign(new Error("kill EPERM"), { code: "EPERM" });

async function protocolOutput(chunks: Buffer[], maxBytes: number) {
  const transport = new AgentTransport(
    process.execPath,
    [
      "-e",
      `process.stdin.once('data', async () => {
        for (const hex of JSON.parse(process.argv[1])) {
          await new Promise((resolve, reject) => process.stdout.write(Buffer.from(hex, 'hex'), error => error ? reject(error) : resolve()));
          await new Promise(resolve => setTimeout(resolve, 2));
        }
        process.exit(0);
      });`,
      JSON.stringify(chunks.map((chunk) => chunk.toString("hex"))),
    ],
    process.cwd(),
    process.env,
    maxBytes,
  );
  transports.push(transport);
  const messages: unknown[] = [];
  const errors: (Error & { code?: string })[] = [];
  transport.json(
    (value) => messages.push(value),
    (error) => errors.push(error),
  );
  transport.child.stdin.write("start\n");
  await transport.closed;
  return { messages, errors };
}

it("handles a fragmented large protocol message with linear byte accounting", async () => {
  const transport = await runningTransport();
  const text = "a".repeat(512 * 1024);
  const wire = JSON.stringify({ text }) + "\n";
  const messages: unknown[] = [];
  const errors: Error[] = [];
  transport.json(
    (value) => messages.push(value),
    (error) => errors.push(error),
  );
  const byteLength = Buffer.byteLength;
  let inspectedBytes = 0;
  const measure = vi
    .spyOn(Buffer, "byteLength")
    .mockImplementation((value, encoding) => {
      if (typeof value === "string")
        inspectedBytes += byteLength(value, encoding);
      return byteLength(value, encoding);
    });
  try {
    for (let offset = 0; offset < wire.length; offset += 1024)
      transport.child.stdout.emit("data", wire.slice(offset, offset + 1024));
  } finally {
    measure.mockRestore();
  }
  expect(errors).toEqual([]);
  expect(messages).toEqual([{ text }]);
  // Bound parsing work by input size, without relying on runner speed or a timeout.
  expect(inspectedBytes).toBeLessThanOrEqual(byteLength(wire) * 2);
});

it("applies the limit per message when several legal JSON lines share a chunk", async () => {
  const first = Buffer.from('{"n":1}\n');
  const { messages, errors } = await protocolOutput(
    [Buffer.concat([first, Buffer.from('{"n":2}\r\n\n{"n":3}\n')])],
    9,
  );
  expect(messages).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  expect(errors).toEqual([]);
});

it("counts UTF-8 bytes across split code points at the message limit", async () => {
  const wire = Buffer.from('{"text":"🌍"}\n');
  const split = wire.indexOf(Buffer.from("🌍")) + 2;
  const chunks = [
    wire.subarray(0, split),
    wire.subarray(split, -1),
    wire.subarray(-1),
  ];
  const accepted = await protocolOutput(chunks, wire.length);
  expect(accepted.messages).toEqual([{ text: "🌍" }]);
  expect(accepted.errors).toEqual([]);
  const rejected = await protocolOutput(chunks, wire.length - 1);
  expect(rejected.messages).toEqual([]);
  expect(rejected.errors).toHaveLength(1);
  expect(rejected.errors[0]).toMatchObject({
    code: "AGENT_PROTOCOL_MESSAGE_LIMIT",
  });
});

it("reports a terminal protocol error only once and ignores subsequent output", async () => {
  const { messages, errors } = await protocolOutput(
    [Buffer.from('xxxxxxxxxxxxxxxx\n{"ok":true}\n')],
    8,
  );
  expect(messages).toEqual([]);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ code: "AGENT_PROTOCOL_MESSAGE_LIMIT" });
});

it.each([
  ['{"n":1}\n  ', [{ n: 1 }], undefined],
  ['{"n":1}\n{"n":', [{ n: 1 }], "incomplete protocol message"],
  ['null\n{"n":1}\n', [], "invalid structured JSON"],
] as const)(
  "handles protocol EOF and invalid values: %s",
  async (wire, expected, failure) => {
    const { messages, errors } = await protocolOutput(
      [Buffer.from(wire)],
      1024,
    );
    expect(messages).toEqual(expected);
    expect(errors).toHaveLength(failure ? 1 : 0);
    if (failure) expect(errors[0]!.message).toContain(failure);
  },
);

it.skipIf(process.platform === "win32")(
  "waits for confirmed child close when group signaling races with natural exit",
  async () => {
    const transport = await runningTransport();
    const realKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid !== -transport.child.pid! || signal === 0)
        return realKill(pid, signal);
      // The child has started exiting, but its close event has not reached the parent.
      transport.child.stdin.end("exit\n");
      throw permissionError();
    });
    await expect(transport.stop()).resolves.toBeUndefined();
    expect(await transport.closed).toEqual({ code: 0, signal: null });
  },
);

it.skipIf(process.platform === "win32")(
  "retains permission errors when the owned child has not closed",
  async () => {
    const transport = await runningTransport();
    const realKill = process.kill.bind(process);
    const error = permissionError();
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid !== -transport.child.pid!) return realKill(pid, signal);
      throw error;
    });
    await expect(transport.stop()).rejects.toBe(error);
    expect(transport.child.exitCode).toBeNull();
    expect(() => realKill(transport.child.pid!, 0)).not.toThrow();
  },
);

it.skipIf(process.platform === "win32")(
  "retains permission errors if a descendant survives after the leader and its pipes close",
  async () => {
    const transport = await runningTransport(true);
    const realKill = process.kill.bind(process);
    const error = permissionError();
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid !== -transport.child.pid! || signal === 0)
        return realKill(pid, signal);
      transport.child.stdin.end("exit\n");
      throw error;
    });
    await expect(transport.stop()).rejects.toBe(error);
    await transport.closed;
    expect(transport.child.exitCode).toBe(0);
    expect(() => realKill(-transport.child.pid!, 0)).not.toThrow();
  },
);
