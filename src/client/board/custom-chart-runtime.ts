import type {
  CustomChartData,
  CustomChartSpec,
  CustomChartRenderState,
} from "../../shared/custom-charts";

const CHANNEL = "miracle-custom-chart";
export interface FrameIdentity {
  instanceId: string;
  generation: string;
}
export interface ChartRuntimeStatus {
  status: CustomChartRenderState;
  stage?: string;
  message?: string;
}
interface ChartMessage extends FrameIdentity {
  channel: string;
  type: "ready" | "rendered" | "error" | "disposed";
  stage?: string;
  message?: string;
}

/** Only bounded status envelopes cross back into the application. */
export function readChartMessage(
  event: Pick<MessageEvent, "source" | "data">,
  source: Window,
  identity: FrameIdentity,
): ChartMessage | null {
  if (event.source !== source) return null;
  const value = event.data;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.length > 7 ||
    keys.some(
      (key) =>
        ![
          "channel",
          "instanceId",
          "generation",
          "type",
          "stage",
          "message",
        ].includes(key),
    )
  )
    return null;
  if (
    value.channel !== CHANNEL ||
    value.instanceId !== identity.instanceId ||
    value.generation !== identity.generation
  )
    return null;
  if (!["ready", "rendered", "error", "disposed"].includes(value.type))
    return null;
  if (
    value.stage !== undefined &&
    (typeof value.stage !== "string" || value.stage.length > 64)
  )
    return null;
  if (
    value.message !== undefined &&
    (typeof value.message !== "string" || value.message.length > 4000)
  )
    return null;
  if (
    value.type === "error" &&
    (typeof value.stage !== "string" || typeof value.message !== "string")
  )
    return null;
  if (
    value.type !== "error" &&
    (value.stage !== undefined || value.message !== undefined)
  )
    return null;
  return value as ChartMessage;
}

// Self-contained trusted bootstrap. It is stringified only to ship this fixed
// program; no spec, HTML, CSS, cell value or identity is interpolated into srcdoc.
function sandboxBootstrap() {
  const channel = "miracle-custom-chart";
  let identity: { instanceId: string; generation: string } | undefined;
  let started = false;
  let stopped = false;
  let cleanup: (() => void) | undefined;
  const send = (type: string, details: object = {}) => {
    if (identity && !stopped)
      parent.postMessage({ channel, ...identity, type, ...details }, "*");
  };
  const fail = (stage: string, error: unknown) => {
    const message =
      error instanceof Error ? error.stack || error.message : String(error);
    send("error", { stage, message: message.slice(0, 4000) });
  };
  const dispose = () => {
    if (stopped) return;
    const finalCleanup = cleanup;
    cleanup = undefined;
    try {
      finalCleanup?.();
    } catch {
      /* This run has already ended. */
    }
    send("disposed");
    stopped = true;
  };
  addEventListener("pagehide", dispose);
  addEventListener("error", (event) => {
    if (started) fail("runtime", event.error || event.message);
  });
  addEventListener("unhandledrejection", (event) => {
    if (started) fail("runtime", event.reason);
  });
  addEventListener("message", (event) => {
    if (event.source !== parent || stopped) return;
    const value = event.data;
    if (!value || value.channel !== channel) return;
    if (!identity) {
      if (
        value.type !== "connect" ||
        typeof value.instanceId !== "string" ||
        value.instanceId.length > 100 ||
        typeof value.generation !== "string" ||
        value.generation.length > 100
      )
        return;
      identity = { instanceId: value.instanceId, generation: value.generation };
      send("ready");
      return;
    }
    if (
      value.instanceId !== identity.instanceId ||
      value.generation !== identity.generation
    )
      return;
    if (value.type === "dispose") {
      dispose();
      return;
    }
    if (value.type !== "render" || started) return;
    started = true;
    try {
      const root = document.getElementById("chart-root")!;
      const style = document.createElement("style");
      style.textContent = value.spec.css;
      document.head.append(style);
      root.innerHTML = value.spec.html;
      document.documentElement.dataset.theme = value.theme;
      const result = new Function("api", value.spec.javascript)({
        root,
        columns: value.data.columns,
        rows: value.data.rows,
        width: value.width,
        height: value.height,
        theme: value.theme,
      });
      if (result && typeof result.then === "function")
        throw new Error("Инициализация графика должна быть синхронной.");
      if (typeof result === "function") cleanup = result;
      send("rendered");
    } catch (error) {
      fail("init", error);
    }
  });
}

export function customChartShell(): string {
  // A nonce also authorizes external scripts bearing that nonce. This sandbox
  // deliberately permits inline code/eval only, with no nonce/hash/URL source
  // and no strict-dynamic delegation, so generated code cannot enable a CDN.
  // Inline event attributes remain disabled; use addEventListener in the API.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; script-src-attr 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><style>html,body,#chart-root{width:100%;height:100%;margin:0}body{overflow:auto}</style></head><body><div id="chart-root"></div><script>(${sandboxBootstrap.toString()})();</script></body></html>`;
}

/** Owns one opaque frame. Destroying it is the authority for ending a run. */
export function mountCustomChartFrame(options: {
  host: HTMLElement;
  spec: CustomChartSpec;
  data: CustomChartData;
  width: number;
  height: number;
  theme: "dark" | "light";
  onStatus: (status: ChartRuntimeStatus) => void;
}): () => void {
  const { host, onStatus } = options;
  const owner = host.ownerDocument.defaultView!;
  const identity = {
    instanceId: crypto.randomUUID(),
    generation: crypto.randomUUID(),
  };
  const frame = host.ownerDocument.createElement("iframe");
  frame.className = "custom-chart-frame";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.title = options.spec.description || "Кастомный график";
  let stopped = false;
  let loaded = false;
  let sent = false;
  let rendered = false;
  const post = (message: object) =>
    frame.contentWindow?.postMessage(
      { channel: CHANNEL, ...identity, ...message },
      "*",
    );
  const destroy = (immediate = false) => {
    if (stopped) return;
    stopped = true;
    owner.clearTimeout(timeout);
    owner.removeEventListener("message", receive);
    frame.removeEventListener("load", load);
    if (immediate || !sent || !frame.contentWindow) {
      frame.remove();
      return;
    }
    // Give the isolated runtime one bounded chance to run user cleanup. Status
    // authority has already ended; this listener can only remove the old frame.
    frame.style.display = "none";
    const source = frame.contentWindow;
    const remove = () => {
      owner.clearTimeout(cleanupTimeout);
      owner.removeEventListener("message", acknowledge);
      frame.remove();
    };
    const acknowledge = (event: MessageEvent) => {
      if (readChartMessage(event, source, identity)?.type === "disposed")
        remove();
    };
    const cleanupTimeout = owner.setTimeout(remove, 100);
    owner.addEventListener("message", acknowledge);
    post({ type: "dispose" });
  };
  const fail = (stage: string, message: string) => {
    if (stopped) return;
    destroy(true);
    onStatus({ status: "error", stage, message: message.slice(0, 4000) });
  };
  const load = () => {
    if (stopped) return;
    if (loaded) {
      fail(
        "navigation",
        "График перешёл на другую страницу. Повторите отображение.",
      );
      return;
    }
    loaded = true;
    post({ type: "connect" });
  };
  const receive = (event: MessageEvent) => {
    if (stopped || !frame.contentWindow) return;
    const message = readChartMessage(event, frame.contentWindow, identity);
    if (!message) return;
    if (message.type === "ready" && loaded && !sent) {
      sent = true;
      // Explicit projection excludes SQL, connection metadata and credentials.
      post({
        type: "render",
        spec: options.spec,
        data: { columns: options.data.columns, rows: options.data.rows },
        width: options.width,
        height: options.height,
        theme: options.theme,
      });
    } else if (message.type === "rendered" && sent && !rendered) {
      rendered = true;
      owner.clearTimeout(timeout);
      onStatus({ status: "rendered" });
    } else if (message.type === "error" && sent)
      fail(message.stage!, message.message!);
  };
  const timeout = owner.setTimeout(
    () =>
      fail(
        "timeout",
        "График не завершил инициализацию. Повторите отображение или попросите агента исправить код.",
      ),
    10000,
  );
  owner.addEventListener("message", receive);
  frame.addEventListener("load", load);
  frame.srcdoc = customChartShell();
  host.append(frame);
  onStatus({ status: "rendering" });
  return () => destroy();
}
