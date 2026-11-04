import { describe, expect, it } from "vitest";
import { isClickhouseAggregateFunction } from "../src/client/clickhouse-completion";
import type { SqlFunctionCatalog } from "../src/shared/types";

describe("ClickHouse functions excluded from grouping keys", () => {
  it.each(["count", "SUM", "argMax", "quantile", "groupArray", "stddevPop"])(
    "recognizes the built-in aggregate %s without metadata",
    (name) => expect(isClickhouseAggregateFunction(name)).toBe(true),
  );

  it.each(["toDate", "arraySum", "arrayReduce", "multiIf", "unknownFunction"])(
    "does not confuse scalar or unknown %s with an aggregate",
    (name) => expect(isClickhouseAggregateFunction(name)).toBe(false),
  );

  it.each(["row_number", "denseRank", "lagInFrame", "GROUPING"])(
    "excludes the non-grouping function %s even without OVER metadata",
    (name) => expect(isClickhouseAggregateFunction(name)).toBe(true),
  );

  it.each(["row_number", "GROUPING"])(
    "excludes %s when the server reports it as a non-aggregate",
    (name) => {
      const catalog: SqlFunctionCatalog = {
        functions: [{ name, isAggregate: false }],
        aggregateCombinators: [],
      };
      expect(isClickhouseAggregateFunction(name, catalog)).toBe(true);
    },
  );

  it.each([
    "sumIf",
    "SUMARRAYIF",
    "sumSimpleState",
    "uniqExactMergeState",
    "sumArrayIfOrNull",
    "quantileResample",
    "avgArgMax",
  ])("recognizes composed aggregate %s", (name) => {
    expect(isClickhouseAggregateFunction(name)).toBe(true);
  });

  it.each(["arraySumIf", "toDateOrNull", "unknownFunctionState", "If", ""])(
    "does not invent an aggregate from scalar or missing base %s",
    (name) => expect(isClickhouseAggregateFunction(name)).toBe(false),
  );

  it("uses exact catalog classification before built-ins and suffix inference", () => {
    const catalog: SqlFunctionCatalog = {
      functions: [
        { name: "sum", isAggregate: false },
        { name: "customAggregate", isAggregate: true },
        { name: "uniqExactIf", isAggregate: false },
      ],
      aggregateCombinators: [],
    };
    expect(isClickhouseAggregateFunction("SUM", catalog)).toBe(false);
    expect(isClickhouseAggregateFunction("uniqExactIf", catalog)).toBe(false);
    expect(isClickhouseAggregateFunction("customAggregate", catalog)).toBe(
      true,
    );
    expect(isClickhouseAggregateFunction("customAggregateIf", catalog)).toBe(
      true,
    );
    expect(isClickhouseAggregateFunction("sumIf", catalog)).toBe(false);
    expect(isClickhouseAggregateFunction("count", catalog)).toBe(true);
  });

  it("recognizes a server-provided combinator only over an aggregate base", () => {
    const catalog: SqlFunctionCatalog = {
      functions: [{ name: "customAggregate", isAggregate: true }],
      aggregateCombinators: ["CustomSuffix", ""],
    };
    expect(
      isClickhouseAggregateFunction("customAggregateCustomSuffixIf", catalog),
    ).toBe(true);
    expect(isClickhouseAggregateFunction("toDateCustomSuffix", catalog)).toBe(
      false,
    );
    expect(isClickhouseAggregateFunction("unknownFunction", catalog)).toBe(
      false,
    );
  });

  it("terminates on a long suffix chain and still requires an aggregate base", () => {
    expect(isClickhouseAggregateFunction(`sum${"If".repeat(1000)}`)).toBe(true);
    expect(isClickhouseAggregateFunction(`missing${"If".repeat(1000)}`)).toBe(
      false,
    );
  });
});
