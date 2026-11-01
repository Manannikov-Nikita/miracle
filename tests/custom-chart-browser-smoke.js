// Playwright CLI run-code --filename tests/custom-chart-browser-smoke.js
// Requires tests/custom-chart-browser-server.mjs and its temporary fixture board.
async (page) => {
  const checks = [];
  const request = (method, path, body) =>
    page.evaluate(
      async ({ method, path, body }) => {
        const session = await (await fetch("/api/session")).json();
        const response = await fetch(path, {
          method,
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": session.csrfToken,
          },
          ...(body === undefined
            ? {}
            : {
                body: JSON.stringify({
                  ...body,
                  mutationId: crypto.randomUUID(),
                }),
              }),
        });
        const value = await response.json();
        if (!response.ok) throw new Error(JSON.stringify(value));
        return value;
      },
      { method, path, body },
    );
  const boards = await request("GET", "/api/boards");
  const summary = boards.find(
    (board) => board.name === "Кастомные графики — проверка",
  );
  if (!summary) throw new Error("Temporary fixture board required");
  const original = await request("GET", `/api/boards/${summary.id}`);
  const first = original.document.nodes.find(
    (node) => node.id === "vertical-columns",
  );
  const second = original.document.nodes.find(
    (node) => node.id === "infrastructure-waterfall",
  );
  if (!first || !second) throw new Error("Fixture charts missing");
  const save = async (document) => {
    const current = await request("GET", `/api/boards/${summary.id}`);
    return request("PATCH", `/api/boards/${summary.id}`, {
      baseRevision: current.revision,
      document,
    });
  };
  const patchFirst = async (data, dimensions = {}) => {
    const current = await request("GET", `/api/boards/${summary.id}`);
    return save({
      ...current.document,
      nodes: current.document.nodes.map((node) =>
        node.id === first.id
          ? { ...node, ...dimensions, data: { ...node.data, ...data } }
          : node,
      ),
    });
  };
  const article = page.getByRole("article", {
    name: first.data.title,
    exact: true,
  });
  const frame = article.locator("iframe");
  const chart = article.frameLocator("iframe");
  const state = async () =>
    request(
      "GET",
      `/api/boards/${summary.id}/nodes/${first.id}/custom-chart-status`,
    );
  const waitState = async (expected) => {
    for (let i = 0; i < 100; i++) {
      const value = await state();
      if (value.status === expected) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Expected status ${expected}`);
  };
  try {
    await chart.locator("svg").waitFor();
    await page
      .getByRole("article", { name: second.data.title, exact: true })
      .frameLocator("iframe")
      .locator("svg")
      .waitFor();
    await waitState("rendered");
    checks.push("both examples render and report rendered");
    const toggle = chart.getByRole("button", { name: "Подписи значений" });
    await toggle.click();
    if ((await toggle.getAttribute("aria-pressed")) !== "false")
      throw new Error("Click did not toggle labels");
    await toggle.press("Space");
    if ((await toggle.getAttribute("aria-pressed")) !== "true")
      throw new Error("Keyboard did not toggle labels");
    checks.push("click and keyboard interaction");
    await patchFirst({}, { width: 850, height: 720 });
    await chart.locator("svg").waitFor();
    await waitState("rendered");
    if (Number(await frame.evaluate((el) => el.clientWidth)) < 700)
      throw new Error("Resize failed");
    checks.push("resize restarts and renders");
    await patchFirst({ view: "table" });
    await article.locator(".board-table").waitFor();
    if (
      (await request("GET", `/api/boards/${summary.id}`)).document.nodes.find(
        (n) => n.id === first.id,
      ).data.customChart.javascript !== first.data.customChart.javascript
    )
      throw new Error("Table switch lost source");
    await patchFirst({ view: "custom" });
    await chart.locator("svg").waitFor();
    await waitState("rendered");
    checks.push("table/custom switching preserves source");
    await patchFirst({
      customChart: {
        ...first.data.customChart,
        javascript: 'throw new Error("QA deliberate runtime failure");',
      },
    });
    await article
      .getByText("QA deliberate runtime failure", { exact: true })
      .waitFor();
    const failure = await waitState("error");
    if (
      !failure.reports.some((r) =>
        r.message.includes("QA deliberate runtime failure"),
      )
    )
      throw new Error("Error diagnostic missing");
    await article.getByRole("button", { name: "Показать таблицу" }).click();
    await article.locator(".board-table").waitFor();
    await article.getByRole("button", { name: "Вернуться к графику" }).click();
    await article
      .getByRole("button", { name: "Повторить", exact: true })
      .waitFor();
    await article
      .getByRole("button", { name: "Повторить", exact: true })
      .click();
    await waitState("error");
    checks.push("runtime error, diagnostics, fallback table and retry");
    await patchFirst({ customChart: first.data.customChart });
    await chart.locator("svg").waitFor();
    await waitState("rendered");
    await page.reload();
    await chart.locator("svg").waitFor();
    await waitState("rendered");
    checks.push("saved source survives reload");
    await page.route(
      `**/api/result-sets/${first.data.resultSetId}/rows?*`,
      (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "QA metadata failure" }),
        }),
    );
    await page.reload();
    await chart.locator("svg").waitFor();
    await waitState("rendered");
    await page.unroute(`**/api/result-sets/${first.data.resultSetId}/rows?*`);
    checks.push("custom rendering independent of preview metadata failure");
    await page.route(
      `**/api/result-sets/${first.data.resultSetId}/custom-chart`,
      (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "QA bounded data failure" }),
        }),
    );
    await page.reload();
    await article
      .getByText("QA bounded data failure", { exact: true })
      .waitFor();
    await waitState("error");
    await page.unroute(
      `**/api/result-sets/${first.data.resultSetId}/custom-chart`,
    );
    await article
      .getByRole("button", { name: "Повторить", exact: true })
      .click();
    await chart.locator("svg").waitFor();
    await waitState("rendered");
    checks.push("bounded data failure reports error and recovers");
    return { checks };
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await save(original.document);
  }
};
