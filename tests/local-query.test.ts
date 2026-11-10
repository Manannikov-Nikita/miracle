import { afterEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";
import { executeLocalQuery } from "../src/server/local-query.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), "miracle-local-test-"));
  directories.push(projectRoot);
  const dataDir = join(projectRoot, ".miracle");
  await mkdir(dataDir);
  return {
    projectRoot,
    dataDir,
    query: (
      sql: string,
      overrides: Partial<Parameters<typeof executeLocalQuery>[0]> = {},
    ) =>
      executeLocalQuery({
        sql,
        project: { projectRoot, dataDir },
        limits: { maxRows: 100, maxBytes: 65536, timeoutMs: 10000 },
        signal: new AbortController().signal,
        ...overrides,
      }),
  };
}

describe("local DuckDB queries", () => {
  it("preserves exact scalar values, duplicate labels and nested data", async () => {
    const { query } = await fixture();
    const result = await query(`
      select 9007199254740993::bigint as total,
             1.23000000000000000001::decimal(25,20) as total,
             date '2026-11-10' as day,
             {'n': [9223372036854775807::bigint, null], 'j': '{"a":true}'::json} as nested,
             '{"v":9007199254740993}'::json as json_value,
             null::int as missing
    `);
    expect(
      result.columns.map(({ name, sourceName, duckdbType }) => [
        name,
        sourceName,
        duckdbType,
      ]),
    ).toEqual([
      ["total", "total", "BIGINT"],
      ["total_2", "total", "DECIMAL(25,20)"],
      ["day", "day", "DATE"],
      ["nested", "nested", "JSON"],
      ["json_value", "json_value", "JSON"],
      ["missing", "missing", "INTEGER"],
    ]);
    expect(new Set(result.columns.map((column) => column.id)).size).toBe(6);
    expect(result.rows).toEqual([
      [
        "9007199254740993",
        "1.23000000000000000001",
        "2026-11-10",
        { n: ["9223372036854775807", null], j: { a: true } },
        { v: "9007199254740993" },
        null,
      ],
    ]);
  });

  it("joins staged CSV and TSV with JSON and JSONL readers", async () => {
    const { projectRoot, query } = await fixture();
    await Promise.all([
      writeFile(join(projectRoot, "sales'24.csv"), "id,amount\n2,14\n"),
      writeFile(join(projectRoot, "clients.tsv"), "id\tname\n2\tAda\n"),
      writeFile(join(projectRoot, "currency.json"), '[{"id":2,"unit":"EUR"}]'),
      writeFile(
        join(projectRoot, "region.jsonl"),
        '{"id":1,"region":"US"}\n{"id":2,"region":"EU"}\n',
      ),
    ]);
    const result = await query(`
      select amount, name, unit, region
      from read_csv_auto('sales''24.csv') sales
      join read_csv('clients.tsv') clients using (id)
      join read_json_auto('currency.json') currency using (id)
      join read_json('region.jsonl') region using (id)
    `);
    expect(result.rows).toEqual([[14, "Ada", "EUR", "EU"]]);
  });

  it("keeps literal __proto__ fields inside native nested values", async () => {
    const { query } = await fixture();
    const result = await query(`
      SELECT [{'__proto__': 1.23000000000000000001::decimal(25,20), 'a': null}] AS payload,
             {'__proto__': {'id': 9007199254740993::bigint}} AS payload,
             [{'__proto__': 3}, NULL]::STRUCT("__proto__" INTEGER)[2] AS fixed,
             map([12], [{'__proto__': 'a'::blob}]) AS mapped,
             union_value(item := {'__proto__': 5}) AS tagged
    `);
    expect(result.columns.map(({ name }) => name)).toEqual([
      "payload",
      "payload_2",
      "fixed",
      "mapped",
      "tagged",
    ]);
    expect(result.rows).toEqual([
      [
        [{ ["__proto__"]: "1.23000000000000000001", a: null }],
        { ["__proto__"]: { id: "9007199254740993" } },
        [{ ["__proto__"]: 3 }, null],
        [{ key: 12, value: { ["__proto__"]: "YQ==" } }],
        { tag: "item", value: { ["__proto__"]: 5 } },
      ],
    ]);
  });

  it("reports dynamic VARIANT keys the binding cannot decode intact", async () => {
    const { query } = await fixture();
    expect((await query("SELECT {'value': 3}::VARIANT")).rows).toEqual([
      [{ value: 3 }],
    ]);
    await expect(query("SELECT [{'__proto__': 3}]::VARIANT")).rejects.toThrow(
      /CAST.*VARCHAR/,
    );
    expect(
      (
        await query(
          "SELECT CAST({'__proto__': 1.23000000000000000001::DECIMAL(25,20)}::VARIANT AS VARCHAR)",
        )
      ).rows,
    ).toEqual([["{'__proto__': 1.23000000000000000001}"]]);
  });

  it("reads Parquet and a selected XLSX sheet from the local extension", async () => {
    const { projectRoot, query } = await fixture();
    const instance = await DuckDBInstance.create();
    const connection = await instance.connect();
    const quote = (path: string) => "'" + path.replaceAll("'", "''") + "'";
    const asset = new URL(
      "../dist/server/native/duckdb/excel.duckdb_extension",
      import.meta.url,
    );
    try {
      await connection.run(`LOAD ${quote(fileURLToPath(asset))}`);
      await connection.run(
        `COPY (SELECT 2 AS id, 30 AS amount) TO ${quote(join(projectRoot, "quarter.parquet"))} (FORMAT PARQUET)`,
      );
      await connection.run(
        `COPY (SELECT 2 AS id, 'April' AS month) TO ${quote(join(projectRoot, "months.xlsx"))} (FORMAT XLSX, HEADER TRUE, SHEET 'Report 2026')`,
      );
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
    const result = await query(`
      select month, amount from read_xlsx('months.xlsx', sheet = 'Report 2026')
      join read_parquet('quarter.parquet') using (id)
    `);
    expect(result.rows).toEqual([["April", 30]]);
    await expect(
      query("select * from read_xlsx('months.xlsx', sheet = 'Missing')"),
    ).rejects.toThrow(/Missing/);
  });

  it("streams all referenced snapshot chunks with their declared DuckDB types", async () => {
    const { query } = await fixture();
    const result = await query(
      "select sum(amount) AS total, min(day) AS first_day, min(payload->>'tag') AS tag from \"Revenue 2026\"",
      {
        datasets: [
          {
            name: "Revenue 2026",
            columns: [
              {
                id: "a",
                name: "amount",
                sourceName: "amount",
                type: "Decimal",
                duckdbType: "DECIMAL(38,2)",
              },
              {
                id: "d",
                name: "day",
                sourceName: "day",
                type: "Date",
                duckdbType: "DATE",
              },
              {
                id: "j",
                name: "payload",
                sourceName: "payload",
                type: "JSON",
                duckdbType: "JSON",
              },
            ],
            async *chunks() {
              yield [["9007199254740993.25", "2026-11-10", { tag: "b" }]];
              yield [["0.75", "2026-10-01", { tag: "a" }]];
            },
          },
          {
            name: "unused",
            columns: [],
            *chunks() {
              throw new Error("unreferenced snapshot was opened");
            },
          },
        ],
      },
    );
    expect(result.rows).toEqual([["9007199254740994.00", "2026-10-01", "a"]]);
  });

  it("aggregates more input rows than the result limit and retains an empty schema", async () => {
    const { query } = await fixture();
    const columns = [
      {
        id: "x",
        name: "x",
        sourceName: "x",
        type: "BIGINT",
        duckdbType: "BIGINT",
      },
    ];
    let consumed = 0;
    const result = await query(
      "select count(*) AS n, sum(x) AS total from large_input",
      {
        limits: { maxRows: 1, maxBytes: 65536, timeoutMs: 10000 },
        datasets: [
          {
            name: "large_input",
            columns,
            *chunks() {
              for (let offset = 0; offset < 60123; offset += 1000) {
                const rows = Array.from(
                  { length: Math.min(1000, 60123 - offset) },
                  (_, i) => [offset + i],
                );
                consumed += rows.length;
                yield rows;
              }
            },
          },
        ],
      },
    );
    expect(consumed).toBe(60123);
    expect(result.rows).toEqual([[60123, 1807357503]]);
    const empty = await query("select x from empty_input", {
      datasets: [
        {
          name: "empty_input",
          columns,
          *chunks() {
            yield [];
          },
        },
      ],
    });
    expect(empty.rows).toEqual([]);
    expect(empty.columns).toMatchObject([{ name: "x", duckdbType: "BIGINT" }]);
  });

  it("releases a timed-out worker and runs a subsequent query successfully", async () => {
    const { query } = await fixture();
    await expect(
      query("select sum(sin(i::double)) from range(10000000000000) t(i)", {
        limits: { maxRows: 100, maxBytes: 65536, timeoutMs: 400 },
      }),
    ).rejects.toThrow(/врем|timeout/i);
    expect((await query("select 42 as answer")).rows).toEqual([[42]]);
  });

  it.each([
    "select 1; select 2",
    "copy (select 1) to 'out.csv'",
    "INSTALL httpfs",
    "LOAD excel",
    "pragma version",
    "select * from read_csv('../outside.csv')",
    "select * from read_csv('/tmp/outside.csv')",
    "select * from read_csv('https://example.com/data.csv')",
    "select * from read_csv('*.csv')",
    "select * from read_csv('data' || '.csv')",
    "select * from read_csv(['data.csv'])",
    "select * from query('select 1')",
    "select * from json_execute_serialized_sql(json_serialize_sql('select 1'))",
    "select * from read_text('/etc/passwd')",
    "select * from glob('*')",
    "select * from read_csv('test.csv', store_rejects = true)",
    "select * from checkpoint()",
  ])("rejects unsafe SQL: %s", async (sql) => {
    const { projectRoot, query } = await fixture();
    await Promise.all([
      writeFile(join(projectRoot, "test.csv"), "id\n2\n"),
      writeFile(join(projectRoot, "data.csv"), "id\n2\n"),
    ]);
    await expect(query(sql)).rejects.toThrow();
  });

  it("keeps native filesystem access and configuration locked during a query", async () => {
    const { projectRoot, query } = await fixture();
    await writeFile(join(projectRoot, "source.csv"), "id\n2\n");
    const result = await query(`
      SELECT current_setting('enable_external_access'),
             current_setting('lock_configuration'),
             current_setting('memory_limit'),
             current_setting('allow_persistent_secrets')
      FROM read_csv('source.csv')
    `);
    expect(result.rows).toEqual([[false, true, "512.0 MiB", false]]);
    await expect(
      query(
        "SELECT * FROM read_csv('source.csv'), read_csv(concat('source', '.csv'))",
      ),
    ).rejects.toThrow(/Первый аргумент/);
  });

  it("rejects project symlinks and internal data in file readers", async () => {
    const { projectRoot, dataDir, query } = await fixture();
    await writeFile(join(projectRoot, "valid.csv"), "id\n2\n");
    await writeFile(join(dataDir, "secret.csv"), "password\nsecret\n");
    await symlink("valid.csv", join(projectRoot, "alias.csv"));
    await symlink(dataDir, join(projectRoot, "alias-dir"));
    for (const file of [
      "alias.csv",
      "alias-dir/secret.csv",
      ".miracle/secret.csv",
    ]) {
      await expect(
        query(`select * from read_csv('${file}')`),
      ).rejects.toThrow();
    }
  });

  it("rejects staging above the per-run budget before reading a sparse file", async () => {
    const { projectRoot, query } = await fixture();
    const path = join(projectRoot, "large.csv");
    await writeFile(path, "");
    await truncate(path, 2 * 1024 ** 3 + 1);
    await expect(query("select * from read_csv('large.csv')")).rejects.toThrow(
      /2.*(?:GiB|ГиБ)/,
    );
  });

  it("enforces the existing row and byte result limits", async () => {
    const { query } = await fixture();
    await expect(
      query("select * from range(3)", {
        limits: { maxRows: 2, maxBytes: 1000, timeoutMs: 10000 },
      }),
    ).rejects.toThrow(/2/);
    await expect(
      query("select repeat('x', 100)", {
        limits: { maxRows: 2, maxBytes: 20, timeoutMs: 10000 },
      }),
    ).rejects.toThrow(/20/);
  });

  it("terminates a running native query after a cancellation request", async () => {
    const { query } = await fixture();
    const controller = new AbortController();
    const loaded = Promise.withResolvers<void>();
    const promise = query(
      "select sum(sin(i::double + x)) from marker cross join range(10000000000000) t(i)",
      {
        signal: controller.signal,
        datasets: [
          {
            name: "marker",
            columns: [
              {
                id: "0",
                name: "x",
                sourceName: "x",
                type: "INTEGER",
                duckdbType: "INTEGER",
              },
            ],
            *chunks() {
              yield [[1]];
              loaded.resolve();
            },
          },
        ],
      },
    );
    await Promise.race([loaded.promise, promise]);
    const timer = setTimeout(
      () => controller.abort(new Error("cancelled by test")),
      100,
    );
    try {
      await expect(promise).rejects.toThrow("cancelled by test");
      expect((await query("select 7 as after_cancel")).rows).toEqual([[7]]);
    } finally {
      clearTimeout(timer);
    }
  });
});
