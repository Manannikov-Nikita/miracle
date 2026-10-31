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
