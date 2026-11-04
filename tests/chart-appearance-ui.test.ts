// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChartSettings } from "../src/client/board/ResultView";
import { api } from "../src/client/api";
import type { ChartSpec, ResultSet } from "../src/shared/types";

vi.mock("../src/client/board/ChartCanvas", () => ({ default: () => null }));
vi.mock("../src/client/api", () => ({ api: vi.fn(), getResultRows: vi.fn() }));
vi.mock("../src/client/components/Select", () => ({
  Select: (props: {
    value: string;
    disabled?: boolean;
    onValueChange: (value: string) => void;
    options: { value: string; label: string }[];
    "aria-label": string;
  }) =>
    createElement(
      "select",
      {
        value: props.value,
        disabled: props.disabled,
        "aria-label": props["aria-label"],
        onChange: (e: { target: { value: string } }) =>
          props.onValueChange(e.target.value),
      },
      props.options.map((option) =>
        createElement(
          "option",
          { key: option.value, value: option.value },
          option.label,
        ),
      ),
    ),
}));
const result: ResultSet = {
  id: "snapshot-one",
  columns: [
    { id: "month", name: "Месяц", type: "String" },
    { id: "value", name: "Выручка", type: "Float64" },
    { id: "group", name: "Регион", type: "String" },
  ],
  rowCount: 2,
  byteCount: 32,
  createdAt: "2026-11-04",
  source: { connectionId: "connection", sql: "select month, value, region" },
};
const initial: ChartSpec = {
  kind: "bar",
  x: "month",
  y: ["value"],
  legend: true,
};
describe("chart appearance controls", () => {
  let root: Root;
  let host: HTMLDivElement;
  let current: ChartSpec;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(api).mockReset();
    vi.mocked(api).mockResolvedValue({
      result,
      rows: [
        ["Jan", 10, "North"],
        ["Jan", 20, "South"],
      ],
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  async function render(spec = initial, disabled = false) {
    function Harness() {
      const [value, setValue] = useState(spec);
      current = value;
      return createElement(ChartSettings, {
        result,
        spec: value,
        disabled,
        onChange: setValue,
      });
    }
    await act(async () => root.render(createElement(Harness)));
  }
  function control<T extends HTMLElement>(name: string) {
    const element =
      host.querySelector<T>(`[aria-label="${name}"]`) ??
      [...host.querySelectorAll("label")]
        .find((label) => label.textContent?.trim() === name)
        ?.querySelector<T>("input");
    expect(element, name).toBeTruthy();
    return element!;
  }
  async function click(name: string) {
    await act(async () => control<HTMLInputElement>(name).click());
  }
  async function change(name: string, value: string) {
    const el = control<HTMLInputElement | HTMLSelectElement>(name);
    await act(async () => {
      const proto =
        el.tagName === "SELECT"
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  async function openColors() {
    const summary = [...host.querySelectorAll("summary")].find(
      (el) => el.textContent === "Цвета серий",
    )!;
    expect(summary).toBeTruthy();
    await act(async () => {
      summary.parentElement!.setAttribute("open", "");
      summary.parentElement!.dispatchEvent(new Event("toggle"));
    });
  }
  it("keeps old defaults and independently changes axes, grid and labels", async () => {
    await render();
    for (const name of ["Показывать ось X", "Показывать ось Y", "Сетка"])
      expect(control<HTMLInputElement>(name).checked).toBe(true);
    expect(control<HTMLInputElement>("Подписи значений").checked).toBe(false);
    await click("Показывать ось X");
    await click("Сетка");
    await click("Подписи значений");
    expect(current).toMatchObject({
      ...initial,
      showXAxis: false,
      showGrid: false,
      showLabels: true,
    });
    expect(control<HTMLInputElement>("Показывать ось Y").checked).toBe(true);
    await change("Положение подписей", "inside");
    expect(current.labelPosition).toBe("inside");
  });
  it("changes palette and a metric color without fetching or running SQL", async () => {
    await render();
    await change("Палитра", "warm");
    await openColors();
    await change("HEX · Выручка", "#123abc");
    await act(async () =>
      control<HTMLInputElement>("HEX · Выручка").dispatchEvent(
        new FocusEvent("focusout", { bubbles: true }),
      ),
    );
    expect(current.palette).toBe("warm");
    expect(Object.values(current.seriesColors ?? {})).toContain("#123abc");
    expect(api).not.toHaveBeenCalled();
    const reset = host.querySelector<HTMLButtonElement>(
      '[aria-label="Сбросить цвет · Выручка"]',
    )!;
    await act(async () => reset.click());
    expect(Object.keys(current.seriesColors ?? {})).toHaveLength(0);
  });
  it("loads saved breakdown values only when opened and preserves each group override", async () => {
    await render({ ...initial, series: "group" });
    expect(api).not.toHaveBeenCalled();
    await openColors();
    expect(api).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api).mock.calls[0][0]).toBe(
      "/api/result-sets/snapshot-one/chart",
    );
    await change("Цвет · Выручка · South", "#aa5522");
    const key = Object.keys(current.seriesColors ?? {})[0];
    expect(key).toContain("South");
    expect(current.seriesColors?.[key]).toBe("#aa5522");
    await change("Палитра", "cool");
    expect(control<HTMLInputElement>("Цвет · Выручка · South").value).toBe(
      "#aa5522",
    );
    expect(api).toHaveBeenCalledTimes(1);
  });
  it("keeps invalid HEX local and restores the saved color on blur", async () => {
    await render();
    await openColors();
    const old = control<HTMLInputElement>("HEX · Выручка").value;
    await change("HEX · Выручка", "#zzzzzz");
    expect(current.seriesColors).toBeUndefined();
    await act(async () =>
      control<HTMLInputElement>("HEX · Выручка").dispatchEvent(
        new FocusEvent("focusout", { bubbles: true }),
      ),
    );
    expect(control<HTMLInputElement>("HEX · Выручка").value).toBe(old);
  });
  it("keeps axis settings usable when loading series fails and offers retry", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("Snapshot unavailable"));
    await render({ ...initial, series: "group" });
    await openColors();
    expect(host.textContent).toContain("Не удалось загрузить цвета серий");
    await click("Показывать ось Y");
    expect(current.showYAxis).toBe(false);
    const retry = [...host.querySelectorAll("button")].find(
      (el) => el.textContent === "Повторить",
    )!;
    await act(async () => retry.click());
    expect(control("Цвет · Выручка · South")).toBeTruthy();
  });
  it("disables all appearance editors in read-only mode", async () => {
    await render(initial, true);
    await openColors();
    for (const el of host.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLButtonElement
    >("input, select, button"))
      expect(el.matches(":disabled")).toBe(true);
    expect(current).toEqual(initial);
  });
  it("can switch off breakdown after a failed load and edit metric colors", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("Snapshot unavailable"));
    await render({ ...initial, series: "group" });
    await openColors();
    expect(host.textContent).toContain("Не удалось загрузить цвета серий");
    await change("Разбивка", "");
    expect(host.textContent).not.toContain("Не удалось загрузить цвета серий");
    await change("Цвет · Выручка", "#aabbcc");
    expect(Object.values(current.seriesColors ?? {})).toEqual(["#aabbcc"]);
  });
  it("keeps the search clearable after switching from many groups to a single metric", async () => {
    vi.mocked(api).mockResolvedValueOnce({
      result,
      rows: Array.from({ length: 31 }, (_, i) => ["Jan", i, `Region ${i}`]),
    });
    await render({ ...initial, series: "group" });
    await openColors();
    await change("Найти серию", "Region 30");
    expect(control("Цвет · Выручка · Region 30")).toBeTruthy();
    await change("Разбивка", "");
    await change("Найти серию", "");
    expect(control("Цвет · Выручка")).toBeTruthy();
  });
});
