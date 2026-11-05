import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SearchHighlight from "../src/client/components/SearchHighlight";
import SourceSchemaTree from "../src/client/components/SourceSchemaTree";

const mark = (value: string) =>
  `<mark class="explorer-search-match">${value}</mark>`;
const render = (text: string, query: string) =>
  renderToStaticMarkup(createElement(SearchHighlight, { text, query }));

describe("source search highlighting", () => {
  it("marks every literal match while preserving casing and trimming the query", () => {
    expect(render("Revenue_revenue_REVENUE", " revenue ")).toBe(
      `${mark("Revenue")}_${mark("revenue")}_${mark("REVENUE")}`,
    );
    expect(render("Выручка_выручка", "ВЫРУЧКА")).toBe(
      `${mark("Выручка")}_${mark("выручка")}`,
    );
    expect(render("cost[usd].*+cost[usd]", "[usd]")).toBe(
      `cost${mark("[usd]")}.*+cost${mark("[usd]")}`,
    );
  });

  it("does not highlight empty or unmatched queries", () => {
    expect(render("sales_amount", "  ")).toBe("sales_amount");
    expect(render("sales_amount", "orders")).toBe("sales_amount");
  });

  it("keeps offsets aligned after Unicode case folding expands a character", () => {
    expect(render("İD_amount", "amount")).toBe(`İD_${mark("amount")}`);
    expect(render("İD", "i")).toBe(`${mark("İ")}D`);
    expect(render("😀Amount_😀amount", "😀a")).toBe(
      `${mark("😀A")}mount_${mark("😀a")}mount`,
    );
    expect(render("A\u030A_amount", "a")).toBe(
      `${mark("A\u030A")}_${mark("a")}mount`,
    );
  });

  it("uses the same contextual lowercase search as metadata filtering", () => {
    expect(render("ΟΣ", "ος")).toBe(mark("ΟΣ"));
  });

  it("highlights the visible part of a qualified-name or name/type match", () => {
    const table = renderToStaticMarkup(
      createElement(SearchHighlight, {
        text: "table",
        query: "schema.tab",
        searchText: "schema.table",
        textOffset: 7,
      }),
    );
    expect(table).toBe(`${mark("tab")}le`);
    const type = renderToStaticMarkup(
      createElement(SearchHighlight, {
        text: "Float64",
        query: "amount Flo",
        searchText: "amount Float64",
        textOffset: 7,
      }),
    );
    expect(type).toBe(`${mark("Flo")}at64`);
  });

  it("renders names as escaped text even when they contain HTML", () => {
    expect(render("<script>sales</script>", "sales")).toBe(
      `&lt;script&gt;${mark("sales")}&lt;/script&gt;`,
    );
  });

  it("highlights catalog, schema, table, column and type labels in the real tree", () => {
    const props = {
      source: {
        id: "source",
        name: "Source",
        engine: "trino",
        url: "http://localhost",
        username: "reader",
        hasPassword: false,
      },
      metadata: { getColumnError: () => undefined },
      snapshot: {
        status: "ready",
        complete: true,
        background: false,
        schemas: [
          {
            catalog: "sales_catalog",
            schema: "sales_schema",
            status: "ready",
            complete: true,
            columnsComplete: true,
            tables: [
              {
                catalog: "sales_catalog",
                schema: "sales_schema",
                name: "sales_table",
                columns: [{ name: "sales_column", type: "SalesType" }],
              },
            ],
          },
        ],
      },
      views: new Map(),
      filter: "sales",
      onOpenSource() {},
    } as unknown as ComponentProps<typeof SourceSchemaTree>;
    const html = renderToStaticMarkup(createElement(SourceSchemaTree, props));
    expect(html.match(/class="explorer-search-match"/g)).toHaveLength(5);
    for (const suffix of ["_catalog", "_schema", "_table", "_column"])
      expect(html).toContain(`${mark("sales")}${suffix}`);
    expect(html).toContain(`${mark("Sales")}Type`);
    expect(html).toContain('class="source-column"');

    const qualified = renderToStaticMarkup(
      createElement(SourceSchemaTree, {
        ...props,
        filter: "sales_schema.sales_t",
      }),
    );
    expect(qualified).toContain(`${mark("sales_t")}able`);
    const columnType = renderToStaticMarkup(
      createElement(SourceSchemaTree, { ...props, filter: "column Sales" }),
    );
    expect(columnType).toContain(`sales_${mark("column")}`);
    expect(columnType).toContain(`${mark("Sales")}Type`);
  });
});
