import { afterEach, describe, expect, it, vi } from "vitest";
import { attachSqlDiagnostics } from "../src/client/sql-diagnostics-controller";

function fixture(sql = "SELECT city, sum(amount) FROM sales") {
  const makeModel = (value: string) => ({
    value,
    disposed: false,
    getValue() {
      return this.value;
    },
    isDisposed() {
      return this.disposed;
    },
    getPositionAt(offset: number) {
      const lines = this.value.slice(0, offset).split("\n");
      return { lineNumber: lines.length, column: lines.at(-1)!.length + 1 };
    },
  });
  let model = makeModel(sql);
  const listeners = new Map<string, () => void>();
  const listen = (name: string, fn: () => void) => {
    listeners.set(name, fn);
    return { dispose: () => listeners.delete(name) };
  };
  const editor = {
    getModel: () => model,
    onDidChangeModel: (fn: () => void) => listen("model", fn),
    onDidChangeModelContent: (fn: () => void) => listen("content", fn),
    onDidDispose: (fn: () => void) => listen("dispose", fn),
  };
  const markers = vi.fn();
  const api = {
    editor: { setModelMarkers: markers },
    MarkerSeverity: { Error: 8, Warning: 4 },
  };
  let engine: "trino" | "clickhouse" = "trino";
  const controller = attachSqlDiagnostics(editor as any, api as any, () => ({
    engine,
  }));
  return {
    controller,
    markers,
    listeners,
    get model() {
      return model;
    },
    switchModel(value: string) {
      model = makeModel(value);
      listeners.get("model")?.();
    },
    type(value: string) {
      model.value = value;
      listeners.get("content")?.();
    },
    changeEngine(value: typeof engine) {
      engine = value;
      controller.refresh();
    },
    disposeEditor() {
      listeners.get("dispose")?.();
    },
  };
}
afterEach(() => vi.useRealTimers());

describe("SQL diagnostics Monaco lifecycle", () => {
  it("debounces typing and publishes only the current text with precise markers", () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.advanceTimersByTime(200);
    expect(f.markers.mock.calls.some((call) => call[2].length)).toBe(false);
    f.type("SELECT\n  city, sum(amount)\nFROM sales");
    vi.advanceTimersByTime(349);
    expect(f.markers.mock.calls.some((call) => call[2].length)).toBe(false);
    vi.advanceTimersByTime(1);
    const result = f.markers.mock.lastCall!;
    expect(result[0]).toBe(f.model);
    expect(result[1]).toBe("miracle-sql-validation");
    expect(result[2]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          startLineNumber: 2,
          startColumn: 3,
          endLineNumber: 2,
          endColumn: 7,
          message: expect.stringMatching(/GROUP BY/),
        }),
      ]),
    );
    f.controller.dispose();
  });

  it("clears obsolete markers immediately and removes the warning after correction", () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.advanceTimersByTime(350);
    expect(f.markers.mock.lastCall![2].length).toBeGreaterThan(0);
    f.type("SELECT city, sum(amount) FROM sales GROUP BY city");
    expect(f.markers.mock.lastCall![2]).toEqual([]);
    vi.advanceTimersByTime(350);
    expect(f.markers.mock.lastCall![2]).toEqual([]);
    f.controller.dispose();
  });

  it("clears the previous model on tab change and never applies its pending diagnostics", () => {
    vi.useFakeTimers();
    const f = fixture();
    const previous = f.model;
    vi.advanceTimersByTime(200);
    f.switchModel("SELECT 1");
    expect(f.markers).toHaveBeenCalledWith(
      previous,
      "miracle-sql-validation",
      [],
    );
    vi.advanceTimersByTime(350);
    expect(f.markers.mock.calls.filter((call) => call[2].length)).toEqual([]);
    f.controller.dispose();
  });

  it("rechecks the dialect without changing the SQL model", () => {
    vi.useFakeTimers();
    const f = fixture("SELECT max(b), sum(b) AS b FROM sales");
    vi.advanceTimersByTime(350);
    expect(f.markers.mock.lastCall![2]).toEqual([]);
    f.changeEngine("clickhouse");
    vi.advanceTimersByTime(350);
    expect(f.markers.mock.lastCall![2]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 4,
          message: expect.stringMatching(/алиас/i),
        }),
      ]),
    );
    expect(f.model.value).toBe("SELECT max(b), sum(b) AS b FROM sales");
    f.controller.dispose();
  });

  it("cancels pending validation and removes owned markers/listeners on editor disposal", () => {
    vi.useFakeTimers();
    const f = fixture();
    f.disposeEditor();
    const calls = f.markers.mock.calls.length;
    vi.runAllTimers();
    expect(f.markers).toHaveBeenCalledWith(
      f.model,
      "miracle-sql-validation",
      [],
    );
    expect(f.markers).toHaveBeenCalledTimes(calls);
    expect(f.listeners.size).toBe(0);
    f.controller.dispose();
  });

  it("does not inspect or mark a model already disposed", () => {
    vi.useFakeTimers();
    const f = fixture();
    f.model.disposed = true;
    f.model.getValue = () => {
      throw new Error("disposed model read");
    };
    vi.advanceTimersByTime(350);
    f.controller.dispose();
    expect(f.markers.mock.calls.filter((call) => call[2].length)).toEqual([]);
  });
});
