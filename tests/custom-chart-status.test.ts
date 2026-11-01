import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { CustomChartStatusStore } from "../src/server/custom-chart-status";

const current = { resultSetId: randomUUID(), specHash: "a".repeat(64) };
const report = (
  browserId = randomUUID(),
  sequence = 1,
  sentAt = Date.now(),
) => ({
  browserId,
  sequence,
  sentAt,
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
  store.report("board", "node", current, report(undefined, 1, now));
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
    { sentAt: undefined },
    { sentAt: NaN },
    { sentAt: Infinity },
    { sentAt: Number.MAX_SAFE_INTEGER + 1 },
    { sentAt: 1.1 },
    { sentAt: -1 },
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

it("rejects new keys at capacity and retains live errors and sequence history", () => {
  let now = 100000;
  const store = new CustomChartStatusStore(() => now);
  const first = report(undefined, 1, now);
  store.report("b0", "n", current, { ...first, sequence: 5, status: "error" });
  for (let i = 1; i < 1000; i++)
    store.report(`b${i}`, "n", current, report(undefined, 1, now));
  expect(() =>
    store.report("overflow", "n", current, report(undefined, 1, now)),
  ).toThrow(
    expect.objectContaining({
      statusCode: 429,
      code: "CUSTOM_CHART_REPORT_CAPACITY",
    }),
  );
  store.report("b0", "n", current, { ...first, sequence: 4 });
  expect(store.read("b0", "n", current).status).toBe("error");
  store.report("b0", "n", current, { ...first, sequence: 6 });
  expect(store.read("b0", "n", current).status).toBe("rendered");
  now = 160000;
  store.report("overflow", "n", current, report(undefined, 1, now));
  expect(store.read("overflow", "n", current).status).toBe("rendered");
});

it.each([4, 5])(
  "cannot resurrect an expired newer error from delayed sequence %i",
  (sequence) => {
    let now = 100000;
    const store = new CustomChartStatusStore(() => now);
    const browser = randomUUID();
    const delayed = report(browser, sequence, now);
    store.report("board", "node", current, {
      ...report(browser, 5, now),
      status: "error",
    });
    now = 160001;
    expect(store.read("board", "node", current).status).toBe("not_observed");
    expect(() => store.report("board", "node", current, delayed)).toThrow(
      expect.objectContaining({ code: "CUSTOM_CHART_REPORT_STALE" }),
    );
    expect(store.read("board", "node", current).status).toBe("not_observed");
  },
);

it("retains a fast-clock sequence watermark beyond visible expiry without extending observation TTL", () => {
  let now = 100000;
  const store = new CustomChartStatusStore(() => now);
  const browser = randomUUID();
  const delayed = report(browser, 4, 103999);
  store.report("board", "node", current, {
    ...report(browser, 5, 104000),
    status: "error",
  });
  now = 160001;
  expect(store.read("board", "node", current).status).toBe("not_observed");
  store.report("board", "node", current, delayed);
  expect(store.read("board", "node", current).status).toBe("not_observed");
  now = 164000;
  expect(() => store.report("board", "node", current, delayed)).toThrow(
    expect.objectContaining({ code: "CUSTOM_CHART_REPORT_STALE" }),
  );
  expect(store.read("board", "node", current).status).toBe("not_observed");
});

it("accepts only fresh safe timestamp bounds and at most five seconds of future skew", () => {
  const now = 100000;
  const store = new CustomChartStatusStore(() => now);
  expect(() =>
    store.report("board", "node", current, report(undefined, 1, now - 60000)),
  ).toThrow(expect.objectContaining({ code: "CUSTOM_CHART_REPORT_STALE" }));
  expect(() =>
    store.report("board", "node", current, report(undefined, 1, now + 5001)),
  ).toThrow(expect.objectContaining({ code: "CUSTOM_CHART_REPORT_TIME" }));
  store.report("board", "node", current, report(undefined, 1, now - 59999));
  store.report("board", "node", current, report(undefined, 1, now + 5000));
  expect(store.read("board", "node", current).reports).toHaveLength(2);
});
