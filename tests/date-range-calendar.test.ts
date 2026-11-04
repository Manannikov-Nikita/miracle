// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DateRangeCalendar, {
  type DateRangeCalendarProps,
} from "../src/client/components/DateRangeCalendar";
import {
  addCalendarDays,
  calendarMonthDate,
  isCalendarDate,
  normalizeDateForCalendar,
} from "../src/client/components/date-range-calendar-helpers";

describe("calendar date arithmetic", () => {
  it("rejects impossible dates and uses calendar-only arithmetic across leap years and DST", () => {
    expect(isCalendarDate("2025-02-29")).toBe(false);
    expect(isCalendarDate("2024-02-29")).toBe(true);
    expect(isCalendarDate("2025-13-01")).toBe(false);
    expect(isCalendarDate("0000-01-01")).toBe(false);
    expect(normalizeDateForCalendar("bad", "week")).toBe("");
    expect(addCalendarDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addCalendarDays("2026-03-28", 2)).toBe("2026-03-30");
    expect(calendarMonthDate(12)).toBe("0001-01-01");
    expect(normalizeDateForCalendar("0001-01-01", "week")).toBe("0001-01-01");
    expect(normalizeDateForCalendar("0001-01-01", "week", "sunday")).toBe("");
    expect(normalizeDateForCalendar("2025-01-01", "week", "sunday")).toBe(
      "2024-12-29",
    );
    expect(normalizeDateForCalendar("2025-01-01", "week")).toBe("2024-12-30");
    expect(normalizeDateForCalendar("2025-01-31", "month")).toBe("2025-01-01");
  });
});

describe("date range calendar", () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: DateRangeCalendarProps;
  const changed = vi.fn();
  async function render(update: Partial<DateRangeCalendarProps> = {}) {
    props = { ...props, ...update };
    await act(async () => root.render(createElement(DateRangeCalendar, props)));
  }
  function date(value: string) {
    const button = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${value}"]`,
    );
    expect(button, `Date ${value} should be rendered`).not.toBeNull();
    return button!;
  }
  async function click(value: string) {
    await act(async () => date(value).click());
  }
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
    changed.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    props = {
      startDate: "2026-10-01",
      endDate: "2026-10-01",
      granularity: "day",
      onChange: (range) => {
        changed(range);
        props = { ...props, ...range };
        root.render(createElement(DateRangeCalendar, props));
      },
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("selects two dates including reversed clicks and highlights every intermediate day", async () => {
    await render();
    await click("2026-10-20");
    expect(changed).toHaveBeenLastCalledWith({
      startDate: "2026-10-20",
      endDate: "2026-10-20",
    });
    expect(container.textContent).toContain("Выберите конец диапазона");
    await click("2026-10-04");
    expect(changed).toHaveBeenLastCalledWith({
      startDate: "2026-10-04",
      endDate: "2026-10-20",
    });
    expect(date("2026-10-03").getAttribute("aria-pressed")).toBe("false");
    expect(date("2026-10-04").classList.contains("is-range-start")).toBe(true);
    expect(date("2026-10-12").getAttribute("aria-pressed")).toBe("true");
    expect(date("2026-10-20").classList.contains("is-range-end")).toBe(true);
    expect(date("2026-10-21").getAttribute("aria-pressed")).toBe("false");
    await click("2026-11-01");
    expect(changed).toHaveBeenLastCalledWith({
      startDate: "2026-11-01",
      endDate: "2026-11-01",
    });
  });

  it.each([
    ["monday", "2026-10-05", "2026-10-19", "2026-10-25"],
    ["sunday", "2026-10-04", "2026-10-18", "2026-10-24"],
  ] as const)(
    "selects whole weeks starting on %s",
    async (weekStartsOn, startDate, endDate, finalDay) => {
      await render({ granularity: "week", weekStartsOn });
      await click("2026-10-07");
      await click("2026-10-20");
      expect(changed).toHaveBeenLastCalledWith({ startDate, endDate });
      expect(date(startDate).classList.contains("is-range-start")).toBe(true);
      expect(date(finalDay).classList.contains("is-range-end")).toBe(true);
      expect(date(finalDay).getAttribute("aria-pressed")).toBe("true");
      expect(
        date(addCalendarDays(finalDay, 1)).getAttribute("aria-pressed"),
      ).toBe("false");
      expect(
        container.querySelector(".range-calendar-weekdays")?.firstElementChild
          ?.textContent,
      ).toBe(weekStartsOn === "monday" ? "Пн" : "Вс");
    },
  );

  it("shows only named months in month mode and selects across years", async () => {
    await render({
      granularity: "month",
      startDate: "2026-10-01",
      endDate: "2026-11-01",
    });
    expect(container.querySelector(".range-calendar-day-grid")).toBeNull();
    expect(container.querySelector(".range-calendar-weekdays")).toBeNull();
    expect(date("2026-11-01").textContent).toBe("Ноябрь");
    await click("2026-11-01");
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Следующий год"]')!
        .click();
    });
    expect(container.querySelectorAll("[data-calendar-panel]")).toHaveLength(1);
    expect(
      container
        .querySelector("[data-calendar-panel]")
        ?.getAttribute("data-calendar-panel"),
    ).toBe("2027");
    expect(changed).toHaveBeenLastCalledWith({
      startDate: "2026-11-01",
      endDate: "2026-11-01",
    });
    await click("2027-02-01");
    expect(changed).toHaveBeenLastCalledWith({
      startDate: "2026-11-01",
      endDate: "2027-02-01",
    });
    expect(date("2027-01-01").getAttribute("aria-pressed")).toBe("true");
    expect(date("2027-03-01").getAttribute("aria-pressed")).toBe("false");
  });

  it("reveals externally typed historical dates and resets an unfinished click selection", async () => {
    await render();
    await click("2026-10-02");
    await render({ startDate: "2025-01-01", endDate: "2025-01-15" });
    expect(date("2025-01-05").getAttribute("aria-pressed")).toBe("true");
    await click("2025-01-21");
    expect(changed).toHaveBeenLastCalledWith({
      startDate: "2025-01-21",
      endDate: "2025-01-21",
    });
    expect(container.querySelectorAll("[data-calendar-panel]")).toHaveLength(3);
    await render({ startDate: "2025-", endDate: "bad" });
    expect(
      container.querySelectorAll('button[aria-pressed="true"]'),
    ).toHaveLength(0);
  });

  it("switches between day and month views and keeps supported date bounds", async () => {
    await render();
    for (const selected of ["2026-10-01", "0001-01-01", "9999-12-01"]) {
      await render({
        startDate: selected,
        endDate: selected,
        granularity: "day",
      });
      expect(date(selected).getAttribute("aria-pressed")).toBe("true");
      await render({ granularity: "month" });
      expect(date(selected).getAttribute("aria-pressed")).toBe("true");
      expect(container.querySelector(".range-calendar-day-grid")).toBeNull();
      await render({ granularity: "day" });
      expect(date(selected).getAttribute("aria-pressed")).toBe("true");
      expect(container.querySelectorAll("[data-calendar-panel]")).toHaveLength(
        3,
      );
      expect(
        [
          ...container.querySelectorAll<HTMLButtonElement>(
            "[data-calendar-date]",
          ),
        ].every((button) => isCalendarDate(button.dataset.calendarDate ?? "")),
      ).toBe(true);
    }
  });

  it("supports keyboard navigation across month boundaries and disables selection while busy", async () => {
    await render();
    expect(
      container.querySelectorAll('[data-calendar-date][tabindex="0"]'),
    ).toHaveLength(1);
    expect(date("2026-10-01").tabIndex).toBe(0);
    date("2026-10-31").focus();
    await act(async () => {
      date("2026-10-31").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(date("2026-11-01"));
    expect(date("2026-11-01").tabIndex).toBe(0);
    expect(
      container.querySelectorAll('[data-calendar-date][tabindex="0"]'),
    ).toHaveLength(1);
    await render({ disabled: true });
    await click("2026-11-01");
    expect(changed).not.toHaveBeenCalled();
    expect(
      [...container.querySelectorAll("button")].every(
        (button) => button.disabled,
      ),
    ).toBe(true);
  });

  it("moves exactly one month per arrow without wheel navigation or changing the selected range", async () => {
    await render();
    const panels = () =>
      [...container.querySelectorAll<HTMLElement>("[data-calendar-panel]")].map(
        (panel) => Number(panel.dataset.calendarPanel),
      );
    const initialPanels = panels();
    const next = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Следующий месяц"]',
    )!;
    await act(async () => next.click());
    expect(panels()).toEqual(initialPanels.map((panel) => panel + 1));
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Предыдущий месяц"]',
        )!
        .click(),
    );
    expect(panels()).toEqual(initialPanels);
    await act(async () => {
      container
        .querySelector(".range-calendar-viewport")!
        .dispatchEvent(new WheelEvent("wheel", { deltaY: 400, bubbles: true }));
    });
    expect(panels()).toEqual(initialPanels);
    for (let count = 0; count < 18; count++)
      await act(async () => next.click());
    expect(changed).not.toHaveBeenCalled();
    expect(container.querySelectorAll("[data-calendar-panel]")).toHaveLength(3);
    expect(date("2028-03-01")).toBeTruthy();
  });
});
