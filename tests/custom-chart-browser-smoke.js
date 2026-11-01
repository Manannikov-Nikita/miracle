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
    // Optimistic UI refresh can precede board autosave; the next 20s heartbeat
    // reports again against the committed snapshot. Allow that documented cycle.
    for (let i = 0; i < 350; i++) {
      const value = await state();
      if (value.status === expected) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Expected status ${expected}; completed=${JSON.stringify(checks)}; observed=${JSON.stringify(await state())}`);
  };
  try {
    await page.reload();
    await chart.locator("svg").waitFor();
    await page
      .getByRole("article", { name: second.data.title, exact: true })
      .frameLocator("iframe")
      .locator("svg")
      .waitFor();
    await waitState("rendered");
    checks.push("both examples render and report rendered");
    let externalRequests = 0;
    await page.route("https://chart-probe.invalid/**", (route) => {
      externalRequests++; return route.abort();
    });
    const isolated = await chart.locator("#chart-root").evaluate(async (_root, origin) => {
      const denied = (read) => { try { read(); return false; } catch (e) { return e.name === "SecurityError"; } };
      const parentDOM = denied(() => parent.document.body);
      const storage = denied(() => localStorage.getItem("probe"));
      const api = await fetch(origin + "/api/session").then(() => false, () => true);
      const external = await fetch("https://chart-probe.invalid/data").then(() => false, () => true);
      const subresource = (kind) => new Promise((resolve) => {
        const el = document.createElement(kind);
        if (kind === "script") el.nonce = "miracle-custom-runtime";
        el.onload = () => { el.remove(); resolve(false); };
        el.onerror = () => { el.remove(); resolve(true); };
        el.src = "https://chart-probe.invalid/" + kind;
        document.body.append(el);
      });
      return { parentDOM, storage, api, external, script: await subresource("script"), image: await subresource("img") };
    }, new URL(page.url()).origin);
    if (Object.values(isolated).some((value) => !value) || externalRequests !== 0)
      throw new Error("Isolation probe failed: " + JSON.stringify({ isolated, externalRequests }));
    await page.unroute("https://chart-probe.invalid/**");
    checks.push("parent/storage/API/fetch/external script/image blocked");
    const toggle = chart.getByRole("button", { name: "Подписи значений" });
    // Playwright reports unscaled child coordinates for transformed iframes.
    // Map the button's local box through the board frame's actual zoom, then
    // send a real mouse click (not a scripted DOM click).
    const bounds = await frame.boundingBox();
    const size = await frame.evaluate((el) => ({
      width: el.clientWidth, height: el.clientHeight,
    }));
    const button = await toggle.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    await page.mouse.click(
      bounds.x + (button.x + button.width / 2) * bounds.width / size.width,
      bounds.y + (button.y + button.height / 2) * bounds.height / size.height,
    );
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
    await article.getByRole("table").waitFor();
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
    const preview = await request("GET", `/api/result-sets/${first.data.resultSetId}/rows?offset=0&limit=1`);
    await patchFirst({view: "chart", chart: {kind: "bar", x: preview.result.columns[0].id, y: [preview.result.columns[1].id], legend: true}});
    await article.locator("canvas").waitFor();
    await patchFirst({view: "custom"});
    await chart.locator("svg").waitFor();
    checks.push("ordinary chart still renders");
    await article.getByRole("button", {name: "Обновить снимок", exact: true}).click();
    let refreshed;
    for (let i = 0; i < 100; i++) {
      const board = await request("GET", `/api/boards/${summary.id}`);
      refreshed = board.document.nodes.find((node) => node.id === first.id);
      if (refreshed.data.resultSetId !== first.data.resultSetId) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (refreshed.data.resultSetId === first.data.resultSetId || refreshed.data.customChart.javascript !== first.data.customChart.javascript)
      throw new Error("Snapshot refresh failed or lost source");
    await waitState("rendered");
    await patchFirst({resultSetId: first.data.resultSetId});
    await chart.locator("svg").waitFor();
    checks.push("SQL snapshot refresh retains custom source and renders");
    await patchFirst({
      customChart: {
        ...first.data.customChart,
        javascript: 'throw new Error("QA deliberate runtime failure");',
      },
    });
    await article
      .getByText("Не удалось отобразить кастомный график.", { exact: true })
      .waitFor();
    const failure = await waitState("error");
    if (
      !failure.reports.some((r) =>
        r.message.includes("QA deliberate runtime failure"),
      )
    )
      throw new Error("Error diagnostic missing");
    await article.getByRole("button", { name: "Показать таблицу" }).click();
    await article.getByRole("table").waitFor();
    await article.getByRole("button", { name: "Вернуться к графику" }).click();
    await article
      .getByRole("button", { name: "Повторить", exact: true })
      .waitFor();
    await article
      .getByRole("button", { name: "Повторить", exact: true })
      .click();
    await waitState("error");
    checks.push("runtime error, diagnostics, fallback table and retry");
    await patchFirst({customChart: {...first.data.customChart, javascript: "const = ;"}});
    const syntax = await waitState("error");
    if (!syntax.reports.some((report) => report.stage === "init" && report.message.includes("SyntaxError")))
      throw new Error("Syntax error diagnostic missing");
    checks.push("syntax errors reported");
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
      .getByText("Не удалось отобразить кастомный график.", { exact: true })
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
}
