import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import {
  customChartShell,
  readChartMessage,
  mountCustomChartFrame,
} from "../src/client/board/custom-chart-runtime";

const spec = {
  version: 1 as const,
  description: "Chart",
  html: "<output></output>",
  css: "",
  javascript:
    "api.root.querySelector('output').textContent = api.rows[0][0]; return () => { window.cleaned = true; };",
};
const identity = { instanceId: "frame-1", generation: "run-1" };

describe("custom chart sandbox protocol", () => {
  it("rejects other frames, stale generations, unknown fields and oversized errors", () => {
    const source = {} as Window;
    const envelope = {
      channel: "miracle-custom-chart",
      ...identity,
      type: "rendered",
    };
    const read = (data: unknown, sender: unknown = source) =>
      readChartMessage(
        { data, source: sender } as MessageEvent,
        source,
        identity,
      );
    expect(read(envelope)?.type).toBe("rendered");
    expect(read(envelope, {})).toBeNull();
    expect(read({ ...envelope, generation: "old" })).toBeNull();
    expect(read({ ...envelope, html: "<img>" })).toBeNull();
    expect(read({ ...envelope, type: "request" })).toBeNull();
    expect(
      read({
        ...envelope,
        type: "error",
        stage: "runtime",
        message: "x".repeat(4001),
      }),
    ).toBeNull();
  });

  it("boots trusted code before receiving source and keeps closing-script cell strings inert", () => {
    const reports: unknown[] = [];
    const parent = { postMessage: (message: unknown) => reports.push(message) };
    const dom = new JSDOM(customChartShell(), {
      runScripts: "dangerously",
      beforeParse(window) {
        Object.defineProperty(window, "parent", { value: parent });
      },
    });
    const send = (data: unknown) =>
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", { data, source: parent as any }),
      );
    expect(dom.window.document.querySelector("output")).toBeNull();
    send({ channel: "miracle-custom-chart", type: "connect", ...identity });
    expect(reports).toContainEqual({
      channel: "miracle-custom-chart",
      type: "ready",
      ...identity,
    });
    const cell =
      "</script><script>window.injected=true</script>9007199254740993";
    send({
      channel: "miracle-custom-chart",
      type: "render",
      ...identity,
      spec,
      data: {
        columns: [{ id: "v", name: "Value", type: "String" }],
        rows: [[cell]],
      },
      width: 300,
      height: 200,
      theme: "dark",
    });
    expect(dom.window.document.querySelector("output")?.textContent).toBe(cell);
    expect((dom.window as any).injected).toBeUndefined();
    expect(reports).toContainEqual({
      channel: "miracle-custom-chart",
      type: "rendered",
      ...identity,
    });
    send({ channel: "miracle-custom-chart", type: "dispose", ...identity });
    expect((dom.window as any).cleaned).toBe(true);
    dom.window.close();
  });

  it("reports syntax errors and rejects asynchronous initialization", () => {
    for (const javascript of ["const = ;", "return Promise.resolve();"]) {
      const reports: any[] = [];
      const parent = {
        postMessage: (message: unknown) => reports.push(message),
      };
      const dom = new JSDOM(customChartShell(), {
        runScripts: "dangerously",
        beforeParse(window) {
          Object.defineProperty(window, "parent", { value: parent });
        },
      });
      const send = (data: unknown) =>
        dom.window.dispatchEvent(
          new dom.window.MessageEvent("message", {
            data,
            source: parent as any,
          }),
        );
      send({ channel: "miracle-custom-chart", type: "connect", ...identity });
      send({
        channel: "miracle-custom-chart",
        type: "render",
        ...identity,
        spec: { ...spec, javascript },
        data: { columns: [], rows: [] },
        width: 300,
        height: 200,
        theme: "dark",
      });
      expect(reports.at(-1)).toMatchObject({ type: "error", stage: "init" });
      expect(reports.some((r) => r.type === "rendered")).toBe(false);
      dom.window.close();
    }
  });

  it("replaces a navigating frame with an error and ignores later status messages", () => {
    const dom = new JSDOM('<div id="host"></div>');
    const host = dom.window.document.getElementById("host")!;
    const statuses: any[] = [];
    const dispose = mountCustomChartFrame({
      host,
      spec,
      data: { columns: [], rows: [] },
      width: 300,
      height: 200,
      theme: "dark",
      onStatus: (s) => statuses.push(s),
    });
    const frame = host.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    const post = vi
      .spyOn(frame.contentWindow!, "postMessage")
      .mockImplementation(() => {});
    frame.dispatchEvent(new dom.window.Event("load"));
    const connect = post.mock.calls[0][0] as any;
    const message = (type: string) =>
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source: frame.contentWindow,
          data: { ...connect, type },
        }),
      );
    message("ready");
    message("rendered");
    expect(statuses.at(-1).status).toBe("rendered");
    frame.dispatchEvent(new dom.window.Event("load"));
    expect(statuses.at(-1)).toMatchObject({
      status: "error",
      stage: "navigation",
    });
    expect(host.querySelector("iframe")).toBeNull();
    message("rendered");
    expect(statuses.at(-1).status).toBe("error");
    dispose();
    dom.window.close();
  });
});

it("calls cleanup before acknowledging disposal, and ignores later messages", () => {
  const reports: any[] = [];
  const parent = { postMessage: (message: unknown) => reports.push(message) };
  const dom = new JSDOM(customChartShell(), {
    runScripts: "dangerously",
    beforeParse(window) {
      Object.defineProperty(window, "parent", { value: parent });
    },
  });
  const send = (data: unknown) =>
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", { data, source: parent as any }),
    );
  send({ channel: "miracle-custom-chart", type: "connect", ...identity });
  send({
    channel: "miracle-custom-chart",
    type: "render",
    ...identity,
    spec,
    data: { columns: [], rows: [["value"]] },
    width: 100,
    height: 100,
    theme: "dark",
  });
  send({ channel: "miracle-custom-chart", type: "dispose", ...identity });
  expect((dom.window as any).cleaned).toBe(true);
  expect(reports.at(-1).type).toBe("disposed");
  const count = reports.length;
  send({ channel: "miracle-custom-chart", type: "render", ...identity });
  expect(reports).toHaveLength(count);
  dom.window.close();
});
