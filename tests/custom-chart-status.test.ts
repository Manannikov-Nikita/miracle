import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { CustomChartStatusStore } from "../src/server/custom-chart-status";

const current = { resultSetId: randomUUID(), specHash: "a".repeat(64) };
const report = (browserId = randomUUID(), sequence = 1) => ({
  browserId,
  sequence,
  ...current,
  status: "rendered" as const,
});

it("requires browser observation and aggregates all tabs with error then rendering precedence", () => {
  const store = new CustomChartStatusStore();
  expect(store.read("board", "node", current)).toEqual({
    status: "not_observed",
    reports: [],
  });
  const first = report(),
    second = report(),
    third = report();
  store.report("board", "node", current, first);
  store.report("board", "node", current, { ...second, status: "rendering" });
  expect(store.read("board", "node", current).status).toBe("rendering");
  store.report("board", "node", current, {
    ...third,
    status: "error",
    stage: "initialize",
    message: "ReferenceError",
  });
  const value = store.read("board", "node", current);
  expect(value.status).toBe("error");
  expect(value.reports).toHaveLength(3);
  expect(value.reports[2]).toMatchObject({
    message: "ReferenceError",
    observedAt: expect.any(String),
  });
  store.report("board", "node", current, { ...third, sequence: 2 });
  expect(store.read("board", "node", current).status).toBe("rendering");
});

it("does not allow delayed requests or duplicate sequences to replace a newer error", () => {
  const store = new CustomChartStatusStore();
  const first = report(undefined, 5);
  store.report("board", "node", current, { ...first, status: "error" });
  store.report("board", "node", current, { ...first, sequence: 4 });
  store.report("board", "node", current, first);
  expect(store.read("board", "node", current).status).toBe("error");
});

it("expires reports at 60 seconds and invalidates code and snapshot identity", () => {
  let now = 1000;
  const store = new CustomChartStatusStore(() => now);
  store.report("board", "node", current, report());
  now = 60999;
  expect(store.read("board", "node", current).status).toBe("rendered");
  expect(
    store.read("board", "node", { ...current, specHash: "b".repeat(64) }),
  ).toEqual({ status: "not_observed", reports: [] });
  expect(
    store.read("board", "node", { ...current, resultSetId: randomUUID() })
      .status,
  ).toBe("not_observed");
  now = 61000;
  expect(store.read("board", "node", current).status).toBe("not_observed");
});

it("rejects stale identities and malformed or oversized diagnostics", () => {
  const store = new CustomChartStatusStore();
  expect(() =>
    store.report("b", "n", current, { ...report(), specHash: "b".repeat(64) }),
  ).toThrow(/измен/);
  expect(() =>
    store.report("b", "n", current, { ...report(), resultSetId: randomUUID() }),
  ).toThrow(/измен/);
  for (const patch of [
    { sequence: -1 },
    { sequence: 1.1 },
    { browserId: "" },
    { status: "not_observed" },
    { message: "x".repeat(4001) },
    { stage: "x".repeat(101) },
    { rows: [["private"]] },
  ]) {
    expect(() =>
      store.report("b", "n", current, { ...report(), ...patch }),
    ).toThrow();
  }
  expect(store.read("b", "n", current).status).toBe("not_observed");
});

it("bounds memory to the latest 1000 browser observations across boards and nodes", () => {
  const store = new CustomChartStatusStore();
  for (let i = 0; i < 1001; i++) store.report(`b${i}`, "n", current, report());
  expect(store.read("b0", "n", current).status).toBe("not_observed");
  expect(store.read("b1", "n", current).status).toBe("rendered");
  expect(store.read("b1000", "n", current).status).toBe("rendered");
});
