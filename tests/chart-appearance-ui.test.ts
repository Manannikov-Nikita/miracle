// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { chartSpecSchema } from "../src/shared/board-schema";
import { ChartSettings } from "../src/client/board/ResultView";
import { api } from "../src/client/api";
import type { ChartSpec, ResultSet } from "../src/shared/types";

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
  async function render(spec = initial, disabled = false, source = result) {
    function Harness() {
      const [value, setValue] = useState(spec);
      current = value;
      return createElement(ChartSettings, {
        result: source,
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
  async function openSection(title: string) {
    const summary = [...host.querySelectorAll("summary")].find(
      (el) => el.textContent === title,
    )!;
    expect(summary).toBeTruthy();
    await act(async () => {
      summary.parentElement!.setAttribute("open", "");
      summary.parentElement!.dispatchEvent(new Event("toggle"));
    });
  }
  const openColors = () => openSection("Стили серий");
  const openRules = () => openSection("Условное оформление");

  it("edits and clears individual series properties while keeping other styles and legacy colors", async () => {
    const key = '["value",null,null]';
    await render({
      ...initial,
      seriesColors: { [key]: "#112233" },
      seriesStyles: { [key]: { color: "#aabbcc", borderColor: "#224466" } },
    });
    await openColors();
    expect(control<HTMLInputElement>("HEX · Выручка").value).toBe("#aabbcc");
    await click("Стиль · Выручка");
    await change("Узор · Выручка", "crosshatch");
    await change("Непрозрачность · Выручка", "65");
    await change("Линия обводки · Выручка", "dotted");
    await change("Толщина обводки · Выручка", "2.5");
    expect(current.seriesStyles?.[key]).toEqual({
      color: "#aabbcc",
      borderColor: "#224466",
      pattern: "crosshatch",
      opacity: 0.65,
      borderStyle: "dotted",
      borderWidth: 2.5,
    });
    await change("Толщина обводки · Выручка", "9");
    expect(current.seriesStyles?.[key]?.borderWidth).toBe(2.5);
    await click("Сбросить цвет · Выручка");
    expect(control<HTMLInputElement>("HEX · Выручка").value).toBe("#82aaff");
    expect(current.seriesColors).toBeUndefined();
    expect(current.seriesStyles?.[key]?.color).toBeUndefined();
    expect(current.seriesStyles?.[key]?.borderColor).toBe("#224466");
    await change("Непрозрачность · Выручка", "0");
    expect(current.seriesStyles?.[key]?.opacity).toBe(0);
    await change("Непрозрачность · Выручка", "");
    expect(current.seriesStyles?.[key]?.opacity).toBeUndefined();
    await click("Сбросить стиль · Выручка");
    expect(current.seriesStyles).toBeUndefined();
    expect(api).not.toHaveBeenCalled();
  });
  it("saves ordered rules for a real breakdown, edits typed source values and restores them after reopening", async () => {
    const source = {
      ...result,
      columns: [
        ...result.columns,
        { id: "verified", name: "Проверено", type: "Nullable(Bool)" },
      ],
    };
    await render({ ...initial, series: "group" }, false, source);
    await openRules();
    await click("Добавить правило");
    await change("Серия для правила", '["value","group","North"]');
    await change("Поле условия", "column");
    await change("Столбец условия", "verified");
    await change("С чем сравнить", "false");
    expect(current.markRules?.[0].when).toEqual({
      field: "column",
      columnId: "verified",
      op: "eq",
      value: false,
    });
    await change("Сравнение", "null");
    expect(current.markRules?.[0].when).toMatchObject({
      op: "eq",
      value: null,
    });
    expect(host.querySelector('[aria-label="С чем сравнить"]')).toBeNull();
    await change("Столбец условия", "value");
    await change("Сравнение", "gte");
    await change("С чем сравнить", "9007199254740993");
    expect(current.markRules?.[0].when).toMatchObject({
      op: "gte",
      value: "9007199254740993",
    });
    await change("С чем сравнить", "15.25");
    expect(current.markRules?.[0].when).toMatchObject({
      op: "gte",
      value: 15.25,
    });
    await change("Поле условия", "x");
    await change("С чем сравнить", "Jan");
    await change("Узор · Правило 1", "dots");
    await click("Добавить последнее значение");
    expect(current.markRules?.[1]).toMatchObject({
      when: { field: "position", op: "last" },
      style: {
        color: "#9299A4",
        opacity: 0.78,
        borderColor: "#BEC5D0",
        borderStyle: "dashed",
        pattern: "diagonal",
      },
    });
    await click("Выше · Правило 2");
    await change("Положение на оси", "first");
    expect(current.markRules?.[1]).toMatchObject({
      seriesKey: '["value","group","North"]',
      when: { field: "x", op: "eq", value: "Jan" },
      style: { pattern: "dots" },
    });
    expect(current.markRules?.[0].when).toEqual({
      field: "position",
      op: "first",
    });
    const saved = chartSpecSchema.parse(JSON.parse(JSON.stringify(current)));
    await render(saved, false, source);
    await openRules();
    await click("Редактировать · Правило 2");
    expect(control<HTMLInputElement>("С чем сравнить").value).toBe("Jan");
    expect(control<HTMLSelectElement>("Серия для правила").value).toBe(
      '["value","group","North"]',
    );
    await click("Удалить · Правило 1");
    expect(current.markRules).toHaveLength(1);
    await click("Удалить · Правило 1");
    expect(current.markRules).toBeUndefined();
  });

  it("limits rule creation and exposes histogram bin and frequency conditions", async () => {
    const rules = Array.from({ length: 32 }, () => ({
      when: { field: "position" as const, op: "last" as const },
      style: {},
    }));
    await render({
      ...initial,
      kind: "histogram",
      x: "value",
      y: [],
      markRules: rules,
    });
    await openRules();
    expect(control<HTMLButtonElement>("Добавить правило").disabled).toBe(true);
    expect(
      control<HTMLButtonElement>("Добавить последнее значение").disabled,
    ).toBe(true);
    await click("Редактировать · Правило 1");
    const fields = [...control<HTMLSelectElement>("Поле условия").options].map(
      (option) => option.label,
    );
    expect(fields).toEqual(["Частота", "Начало интервала", "Положение на оси"]);
    await change("Поле условия", "x");
    await change("С чем сравнить", "12.5");
    expect(current.markRules?.[0].when).toEqual({
      field: "x",
      op: "eq",
      value: 12.5,
    });
    await click("Удалить · Правило 1");
    expect(control<HTMLButtonElement>("Добавить правило").disabled).toBe(false);
  });
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
  it.each(["vertical", "horizontal"] as const)(
    "defaults %s stacked bar totals on independently of segment labels",
    async (orientation) => {
      await render({ ...initial, orientation, stacked: true, series: "group" });
      expect(control<HTMLInputElement>("Итоги столбцов").checked).toBe(true);
      expect(control<HTMLInputElement>("Подписи значений").checked).toBe(false);
      await click("Итоги столбцов");
      expect(current.showTotals).toBe(false);
      await click("Подписи значений");
      expect(current.showLabels).toBe(true);
      expect(control<HTMLInputElement>("Итоги столбцов").checked).toBe(false);
      await click("Итоги столбцов");
      expect(current.showTotals).toBe(true);
      expect(current.showLabels).toBe(true);
    },
  );
  it.each([
    { kind: "bar", stacked: false, series: "group" },
    { kind: "bar", stacked: true },
    { kind: "line", stacked: true, series: "group" },
    { kind: "area", stacked: true, series: "group" },
    { kind: "scatter", stacked: true, series: "group" },
  ] as const)("omits totals when they do not apply: %j", async (patch) => {
    await render({ ...initial, ...patch, showTotals: false });
    expect(host.textContent).not.toContain("Итоги столбцов");
    expect(current.showTotals).toBe(false);
  });
  it("retains the totals preference when stacking or breakdown is toggled", async () => {
    await render({ ...initial, stacked: true, series: "group" });
    await click("Итоги столбцов");
    await click("С накоплением");
    expect(host.textContent).not.toContain("Итоги столбцов");
    await click("С накоплением");
    expect(control<HTMLInputElement>("Итоги столбцов").checked).toBe(false);
    await change("Разбивка", "");
    expect(host.textContent).not.toContain("Итоги столбцов");
    await change("Разбивка", "group");
    expect(control<HTMLInputElement>("Итоги столбцов").checked).toBe(false);
    expect(current.showTotals).toBe(false);
  });
  it("keeps totals read-only with the rest of the chart appearance", async () => {
    await render({ ...initial, stacked: true, series: "group" }, true);
    const totals = control<HTMLInputElement>("Итоги столбцов");
    expect(totals.checked).toBe(true);
    expect(totals.matches(":disabled")).toBe(true);
    await act(async () => totals.click());
    expect(current.showTotals).toBeUndefined();
    expect(totals.checked).toBe(true);
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
    expect(
      Object.values(current.seriesStyles ?? {}).map((style) => style.color),
    ).toContain("#123abc");
    expect(api).not.toHaveBeenCalled();
    const reset = host.querySelector<HTMLButtonElement>(
      '[aria-label="Сбросить цвет · Выручка"]',
    )!;
    await act(async () => reset.click());
    expect(Object.keys(current.seriesStyles ?? {})).toHaveLength(0);
  });
  it("loads saved breakdown values only when opened and preserves each group override", async () => {
    await render({ ...initial, series: "group" });
    expect(api).not.toHaveBeenCalled();
    await openColors();
    expect(api).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api).mock.calls[0][0]).toBe(
      "/api/result-sets/snapshot-one/chart",
    );
    await change("HEX · Выручка · South", "#aa5522");
    const key = Object.keys(current.seriesStyles ?? {})[0];
    expect(key).toContain("South");
    expect(current.seriesStyles?.[key]?.color).toBe("#aa5522");
    await change("Палитра", "cool");
    expect(control<HTMLInputElement>("HEX · Выручка · South").value).toBe(
      "#aa5522",
    );
    expect(api).toHaveBeenCalledTimes(1);
  });
  it("edits grouped histogram colors from the full table snapshot without fetching raw chart points", async () => {
    const source = { ...result, id: "histogram-group-colors", rowCount: 6500 };
    const rows = Promise.withResolvers<{
      result: ResultSet;
      rows: (string | number)[][];
    }>();
    vi.mocked(api).mockReturnValueOnce(rows.promise);
    await render(
      { ...initial, kind: "histogram", x: "value", y: [], series: "group" },
      false,
      source,
    );
    expect(control<HTMLSelectElement>("Числовой столбец").options).toHaveLength(
      1,
    );
    await openColors();
    expect(host.textContent).toContain("Загрузка серий…");
    await act(async () =>
      rows.resolve({
        result: source,
        rows: [
          ["Jan", 10, "North"],
          ["Feb", 20, "South"],
        ],
      }),
    );
    expect(control<HTMLInputElement>("HEX · North").value).toBe("#155dfc");
    expect(control<HTMLInputElement>("HEX · South").value).toBe("#8ec5ff");
    const previews = () =>
      [
        ...host.querySelectorAll<HTMLElement>(
          ".board-chart-palette-preview span",
        ),
      ].map((el) => el.style.backgroundColor);
    expect(previews().slice(0, 2)).toEqual([
      "rgb(21, 93, 252)",
      "rgb(142, 197, 255)",
    ]);
    await click("С накоплением");
    expect(control<HTMLInputElement>("HEX · North").value).toBe("#2b7fff");
    expect(previews()[0]).toBe("rgb(43, 127, 255)");
    await change("HEX · South", "#aabbcc");
    expect(current.seriesStyles?.['["value","group","South"]']?.color).toBe(
      "#aabbcc",
    );
    const saved = JSON.parse(JSON.stringify(current)) as ChartSpec;
    await render(saved, false, source);
    expect(
      host.querySelector('[aria-label="Тип графика: Гистограмма"]'),
    ).not.toBeNull();
    await openColors();
    expect(control<HTMLInputElement>("HEX · South").value).toBe("#aabbcc");
    expect(vi.mocked(api).mock.calls.map(([url]) => url)).toEqual([
      "/api/result-sets/histogram-group-colors/table",
    ]);
  });

  it("leaves the type picker available when the histogram snapshot exceeds its limit", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("Снимок превышает лимит"));
    await render({ ...initial, kind: "histogram", x: "value", y: [] }, false, {
      ...result,
      id: "oversized-histogram",
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Не удалось подготовить данные графика",
    );
    expect(
      host.querySelector<HTMLButtonElement>(
        '[aria-label="Тип графика: Гистограмма"]',
      )?.disabled,
    ).toBe(false);
  });

  it("keeps invalid HEX local and restores the saved color on blur", async () => {
    await render();
    await openColors();
    const old = control<HTMLInputElement>("HEX · Выручка").value;
    await change("HEX · Выручка", "#zzzzzz");
    expect(current.seriesStyles).toBeUndefined();
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
    expect(host.textContent).toContain("Не удалось загрузить серии");
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
    expect(host.textContent).toContain("Не удалось загрузить серии");
    await change("Разбивка", "");
    expect(host.textContent).not.toContain("Не удалось загрузить серии");
    await change("HEX · Выручка", "#aabbcc");
    expect(
      Object.values(current.seriesStyles ?? {}).map((style) => style.color),
    ).toEqual(["#aabbcc"]);
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
