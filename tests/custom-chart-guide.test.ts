import { JSDOM } from "jsdom";
import { expect, it } from "vitest";
import { customChartGuide } from "../src/server/custom-chart-guide";

it("runs the guide example against named columns, resizes, handles interaction and cleans up", () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  const root = dom.window.document.getElementById("root")!;
  const example = customChartGuide.example;
  const run = new Function("api", example.javascript);
  root.innerHTML = example.html;
  const cleanup = run({
    root,
    columns: [
      { id: "v", name: "value", type: "Float64" },
      { id: "l", name: "label", type: "String" },
    ],
    rows: [
      [5, "One"],
      [-3, "Two"],
    ],
    width: 480,
    height: 320,
    theme: "light",
  });
  expect(root.querySelector("svg")?.getAttribute("viewBox")).toBe(
    "0 0 480 320",
  );
  expect(root.querySelectorAll("rect")).toHaveLength(2);
  expect(root.textContent).toContain("One");
  expect(root.querySelector("button")?.getAttribute("aria-pressed")).toBe(
    "false",
  );
  root.querySelector("button")!.click();
  expect(root.querySelector("button")?.getAttribute("aria-pressed")).toBe(
    "true",
  );
  cleanup();
  expect(root.childElementCount).toBe(0);
  root.innerHTML = example.html;
  run({
    root,
    columns: [
      { id: "l", name: "label" },
      { id: "v", name: "value" },
    ],
    rows: [],
    width: 800,
    height: 600,
    theme: "dark",
  });
  expect(root.textContent).toContain("Нет данных");
  expect(root.querySelectorAll("rect")).toHaveLength(0);
  dom.window.close();
});
