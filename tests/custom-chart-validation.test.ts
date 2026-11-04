import { describe, expect, it, vi } from "vitest";
import { boardDocumentSchema } from "../src/server/validation";

const spec = {
  version: 1,
  description: "Проверочный график",
  html: "<svg></svg>",
  css: "",
  javascript: "api.root.textContent = String(api.rows.length);",
};
const makeBoard = (patch: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  nodes: [
    {
      id: "custom",
      type: "artifact",
      position: { x: 0, y: 0 },
      data: {
        title: "График",
        kind: "result",
        view: "custom",
        customChart: spec,
        resultSetId: "12aa5d9b-4ebe-4d18-b30f-7c6c5306a4cf",
        source: {
          connectionId: "675d6b67-d3df-4b2d-b4b6-b9fd7cd2e410",
          sql: "SELECT 1",
        },
        ...patch,
      },
    },
  ],
  edges: [],
});

describe("custom chart persisted contract", () => {
  it("accepts versioned source and keeps it when viewing the snapshot as a table", () => {
    expect(
      boardDocumentSchema.parse(makeBoard()).nodes[0].data.customChart,
    ).toEqual(spec);
    expect(
      boardDocumentSchema.parse(makeBoard({ view: "table" })).nodes[0].data
        .customChart,
    ).toEqual(spec);
  });
  it("requires a source spec for the custom view", () => {
    expect(
      boardDocumentSchema.safeParse(makeBoard({ customChart: undefined }))
        .success,
    ).toBe(false);
  });
  it("rejects an unsupported renderer version even while viewing the table", () => {
    expect(
      boardDocumentSchema.safeParse(
        makeBoard({ view: "table", customChart: { ...spec, version: 2 } }),
      ).success,
    ).toBe(false);
  });
  it("does not accept a custom renderer on a note", () => {
    expect(
      boardDocumentSchema.safeParse(makeBoard({ kind: "note" })).success,
    ).toBe(false);
  });
  it("enforces source byte limits rather than only string length", () => {
    expect(
      boardDocumentSchema.safeParse(
        makeBoard({
          customChart: {
            ...spec,
            html: "Я".repeat(90000),
            css: "Я".repeat(90000),
          },
        }),
      ).success,
    ).toBe(false);
  });
  it("enforces the UTF-8 boundary without Node globals when pasting a custom chart", () => {
    const customChart = {
      ...spec,
      html: "🙂".repeat(32768),
      css: "🙂".repeat(32768),
      javascript: "",
    };
    vi.stubGlobal("Buffer", undefined);
    try {
      expect(
        boardDocumentSchema.safeParse(makeBoard({ customChart })).success,
      ).toBe(true);
      expect(
        boardDocumentSchema.safeParse(
          makeBoard({ customChart: { ...customChart, javascript: "x" } }),
        ).success,
      ).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("enforces description and individual source lengths", () => {
    for (const customChart of [
      { ...spec, description: "a".repeat(4001) },
      { ...spec, html: "a".repeat(100001) },
      { ...spec, css: "a".repeat(100001) },
      { ...spec, javascript: "a".repeat(200001) },
    ])
      expect(
        boardDocumentSchema.safeParse(makeBoard({ view: "table", customChart }))
          .success,
      ).toBe(false);
  });
});
