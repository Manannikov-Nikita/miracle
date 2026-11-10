import { afterEach, describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import {
  setImmediate as nextTurn,
  setTimeout as pause,
} from "node:timers/promises";
import { JSDOM } from "jsdom";
import { startCustomChartRun } from "../src/client/board/custom-chart-session";

const spec = {
  version: 1 as const,
  description: "Описание",
  html: "",
  css: "",
  javascript: "",
};
const domains: JSDOM[] = [];
const runs = new Set<() => void>();
function startRun(opts: Parameters<typeof startCustomChartRun>[0]) {
  const dispose = startCustomChartRun(opts);
  const stop = () => {
    runs.delete(stop);
    dispose();
  };
  runs.add(stop);
  return stop;
}
function host() {
  const dom = new JSDOM('<div id="host"></div>');
  domains.push(dom);
  return dom.window.document.getElementById("host")!;
}
function options(element: HTMLElement) {
  return {
    host: element,
    spec,
    boardId: "board",
    nodeId: "node",
    resultSetId: "result",
    width: 300,
    height: 200,
    theme: "dark" as const,
    onStatus: vi.fn(),
    onDiagnosticConnection: vi.fn(),
  };
}
async function waitFor(assertion: () => void) {
  // WebCrypto runs outside the JS event loop and can finish after any fixed
  // delay under load. Poll the observable result using a real monotonic clock;
  // the sentAt test deliberately freezes Date and heartbeat intervals.
  const deadline = performance.now() + 3000;
  let lastError: unknown;
  do {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await pause(5);
  } while (performance.now() < deadline);
  throw lastError;
}
afterEach(() => {
  // Failed assertions must not leave a pending digest reporting into the next
  // test's fetch stub, or leave its heartbeat running after fake timers reset.
  for (const stop of runs) stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  domains.splice(0).forEach((dom) => dom.window.close());
});

describe("custom chart client lifecycle", () => {
  it("aborts a replaced fetch and never mounts or reports its late result", async () => {
    let resolveData: (response: Response) => void = () => {};
    let dataSignal: AbortSignal | undefined;
    const reports: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init: RequestInit) => {
        if (path.endsWith("/custom-chart")) {
          dataSignal = init.signal as AbortSignal;
          return new Promise<Response>((resolve) => {
            resolveData = resolve;
          });
        }
        reports.push(JSON.parse(init.body as string));
        return Promise.resolve(Response.json({ ok: true }));
      }),
    );
    const element = host();
    const opts = options(element);
    const stop = startRun(opts);
    await waitFor(() => expect(dataSignal).toBeDefined());
    stop();
    const count = reports.length;
    resolveData(Response.json({ columns: [], rows: [] }));
    await nextTurn();
    expect(dataSignal?.aborted).toBe(true);
    expect(element.querySelector("iframe")).toBeNull();
    expect(reports).toHaveLength(count);
    expect(
      opts.onStatus.mock.calls.some(([s]) => s.status === "rendered"),
    ).toBe(false);
  });

  it("retries failed data loading with a fresh frame and keeps page sequences increasing", async () => {
    const reports: any[] = [];
    let failed = true;
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init: RequestInit) => {
        if (path.endsWith("/custom-chart"))
          return Promise.resolve(
            failed
              ? Response.json({ error: "Агрегируйте SQL" }, { status: 422 })
              : Response.json({ columns: [], rows: [] }),
          );
        reports.push(JSON.parse(init.body as string));
        return Promise.resolve(Response.json({ ok: true }));
      }),
    );
    const element = host();
    const opts = options(element);
    let stop = startRun(opts);
    await waitFor(() =>
      expect(opts.onStatus.mock.calls.at(-1)?.[0]).toMatchObject({
        status: "error",
        stage: "data",
        message: "Агрегируйте SQL",
      }),
    );
    stop();
    failed = false;
    stop = startRun(opts);
    await waitFor(() => expect(element.querySelector("iframe")).not.toBeNull());
    expect(new Set(reports.map((r) => r.browserId)).size).toBe(1);
    expect(
      reports.every((r, i) => i === 0 || r.sequence > reports[i - 1].sequence),
    ).toBe(true);
    expect(reports.every((r) => /^[a-f0-9]{64}$/.test(r.specHash))).toBe(true);
    stop();
  });

  it("shows diagnostic disconnection separately without inventing a rendered report", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) =>
        path.endsWith("/custom-chart")
          ? Promise.resolve(Response.json({ columns: [], rows: [] }))
          : Promise.reject(new Error("offline")),
      ),
    );
    const opts = options(host());
    const stop = startRun(opts);
    await waitFor(() =>
      expect(opts.onDiagnosticConnection).toHaveBeenLastCalledWith(false),
    );
    expect(
      opts.onStatus.mock.calls.some(([s]) => s.status === "rendered"),
    ).toBe(false);
    stop();
  });
});

it("heartbeats the current status and stops all reporting after unmount", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const reports: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string, init: RequestInit) => {
      if (path.endsWith("/custom-chart"))
        return Promise.resolve(Response.json({ columns: [], rows: [] }));
      reports.push(JSON.parse(init.body as string));
      return Promise.resolve(Response.json({ ok: true }));
    }),
  );
  const element = host();
  const opts = options(element);
  const posted: any[] = [];
  const append = element.append.bind(element);
  vi.spyOn(element, "append").mockImplementation((...nodes) => {
    append(...nodes);
    const frame = element.querySelector("iframe")!;
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(
      (message) => {
        posted.push(message);
      },
    );
  });
  const stop = startRun(opts);
  await waitFor(() => expect(posted[0]?.type).toBe("connect"));
  const frame = element.querySelector("iframe")!;
  const dom = element.ownerDocument.defaultView!;
  const connect = posted[0];
  const send = (details: object) =>
    dom.dispatchEvent(
      new dom.MessageEvent("message", {
        source: frame.contentWindow,
        data: { ...connect, ...details },
      }),
    );
  send({ type: "ready" });
  send({ type: "rendered" });
  await vi.advanceTimersByTimeAsync(20000);
  expect(reports.at(-1).status).toBe("rendered");
  send({ type: "error", stage: "runtime", message: "Interaction failed" });
  const errorIndex = reports.length - 1;
  await vi.advanceTimersByTimeAsync(40000);
  expect(reports.slice(errorIndex).every((r) => r.status === "error")).toBe(
    true,
  );
  stop();
  const count = reports.length;
  await vi.advanceTimersByTimeAsync(60000);
  expect(reports).toHaveLength(count);
  vi.useRealTimers();
});

it("ignores late diagnostic responses from a previous upload", async () => {
  const uploads: {
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
  }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string) => {
      if (path.endsWith("/custom-chart"))
        return Promise.resolve(Response.json({ columns: [], rows: [] }));
      return new Promise<Response>((resolve, reject) =>
        uploads.push({ resolve, reject }),
      );
    }),
  );
  const opts = options(host());
  const stop = startRun(opts);
  await waitFor(() => expect(uploads.length).toBeGreaterThan(1));
  uploads.at(-1)!.resolve(Response.json({ ok: true }));
  await waitFor(() =>
    expect(opts.onDiagnosticConnection).toHaveBeenLastCalledWith(true),
  );
  uploads[0].reject(new Error("old failure"));
  // Drain this completed request's rejection chain before the negative check.
  await nextTurn();
  expect(opts.onDiagnosticConnection).toHaveBeenLastCalledWith(true);
  stop();
});

it("captures sentAt when creating a payload and preserves it across session retries", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(100000);
  const reports: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string, init: RequestInit) => {
      if (path.endsWith("/custom-chart"))
        return new Promise<Response>(() => {});
      if (path === "/api/session")
        return Promise.resolve(
          Response.json({
            workspaceId: "sent-at-test",
            instanceId: "sent-at-test",
            csrfToken: "refreshed",
          }),
        );
      reports.push(JSON.parse(init.body as string));
      if (reports.length === 1) {
        vi.setSystemTime(104000);
        return Promise.resolve(
          Response.json({ error: "Expired" }, { status: 401 }),
        );
      }
      return Promise.resolve(Response.json({ ok: true }));
    }),
  );
  const opts = options(host());
  const stop = startRun(opts);
  await waitFor(() =>
    expect(opts.onDiagnosticConnection).toHaveBeenLastCalledWith(true),
  );
  expect(reports).toHaveLength(2);
  expect(reports.map((report) => report.sentAt)).toEqual([100000, 100000]);
  expect(reports[1].sequence).toBe(reports[0].sequence);
  await vi.advanceTimersByTimeAsync(20000);
  expect(reports).toHaveLength(3);
  expect(reports[2].sentAt).toBe(124000);
  expect(reports[2].sequence).toBeGreaterThan(reports[1].sequence);
  expect(opts.onDiagnosticConnection).toHaveBeenLastCalledWith(true);
  stop();
});

it("renders a readonly chart from its snapshot without publishing diagnostics", async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      requests.push(path);
      return Response.json({ columns: [], rows: [] });
    }),
  );
  const element = host();
  const stop = startRun({
    ...options(element),
    reportStatus: false,
  });
  try {
    await waitFor(() => expect(element.querySelector("iframe")).not.toBeNull());
    expect(requests).toEqual(["/api/result-sets/result/custom-chart"]);
  } finally {
    stop();
  }
});
