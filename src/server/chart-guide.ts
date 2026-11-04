import { z } from "zod";
import { chartSpecSchema } from "../shared/board-schema.js";
import {
  CHART_PALETTES,
  CHART_SERIES_COLOR_KEY_LIMIT,
  CHART_SERIES_COLOR_LIMIT,
  chartSeriesColorKey,
} from "../shared/chart-appearance.js";
import type { ChartSpec } from "../shared/types.js";

// Use the persistence schema for discovery too; avoid a second list of fields.
const { $schema: _dialect, ...generatedChartSchema } = z.toJSONSchema(
  chartSpecSchema,
  { target: "draft-7", io: "input" },
);
const propertySchema = (key: string) => {
  const property = generatedChartSchema.properties?.[key];
  return typeof property === "object" && property !== null ? property : {};
};
export const chartInputSchema = {
  ...generatedChartSchema,
  description:
    "Complete standard chart settings. This replaces data.chart, so read_board first and merge intended changes into the existing chart object. Column bindings use result column IDs, not names. Read chart_guide for defaults, stable color keys and resizing.",
  properties: {
    ...generatedChartSchema.properties,
    seriesColors: {
      ...propertySchema("seriesColors"),
      maxProperties: CHART_SERIES_COLOR_LIMIT,
      description:
        "HEX colors keyed by JSON.stringify([metricColumnId, breakdownColumnId ?? null, rawGroupValue ?? null]); without breakdown use [metricColumnId,null,null]. Preserve raw group types. Empty object resets all overrides.",
    },
    xLabel: {
      ...propertySchema("xLabel"),
      deprecated: true,
      description:
        "Legacy value retained for compatibility; rendered axis names come from selected columns.",
    },
    yLabel: {
      ...propertySchema("yLabel"),
      deprecated: true,
      description:
        "Legacy value retained for compatibility; rendered axis names come from selected columns.",
    },
  },
};

const example: ChartSpec = {
  kind: "bar",
  x: "month-id",
  y: ["revenue-id"],
  series: "channel-id",
  legend: true,
  showXAxis: true,
  showYAxis: false,
  showGrid: false,
  showLabels: true,
  labelPosition: "outside",
  palette: "warm",
  numberFormat: "compact",
  seriesColors: {
    [chartSeriesColorKey("revenue-id", "channel-id", "Online")]: "#82aaff",
    [chartSeriesColorKey("revenue-id", "channel-id", "Stores")]: "#8ec9b0",
  },
};

export const chartGuide = {
  version: 1,
  contract:
    "Standard chart nodes use type:'artifact', data.kind:'result', data.view:'chart', a completed data.resultSetId and data.source SQL, plus data.chart. The same controls as the properties panel are available through board_patch update_node. Styling and resizing reuse the saved snapshot; do not run SQL or replace resultSetId/source to change presentation. For programmable view:'custom', edit customChart source using custom_chart_guide; data.chart styling does not control custom JavaScript.",
  schema: chartInputSchema,
  workflow:
    "Read the target with read_board, checking its ID and current revision; follow JSON paging when needed. Read result columns and bounded rows with read_result to verify column IDs and raw group values. board_patch update_node.patch merges node fields and data only one level deep: data.chart is REPLACED, not recursively merged. Spread all current chart fields, then apply requested changes; send a complete chart with kind,x,y,legend. Preserve unrelated settings/source/snapshot. Use current baseRevision and a fresh UUID mutationId for each intended mutation. Reuse mutationId only for an identical retry; reread after REVISION_CONFLICT. Read the board back after saving. Successful persistence is not browser visual verification.",
  controls: {
    kind: "bar, line, area or scatter. orientation vertical/horizontal applies only to bar.",
    x: "Category column ID; scatter requires a numeric X column. On horizontal bars this category is placed on physical Y.",
    y: "Array of numeric metric column IDs, up to20. At least one is needed to render.",
    series:
      "Optional breakdown column ID. Omit to remove breakdown; do not send null.",
    stacked:
      "Stack breakdown groups within each metric; requires series and applies to bar/line/area. Scatter ignores it. SQL must supply one row per category/group for stacking.",
    showXAxis:
      "Boolean, defaulttrue. Hide/show physical X axis name, ticks and labels independently of grid, including on horizontal bars.",
    showYAxis:
      "Boolean, defaulttrue. Hide/show physical Y axis name, ticks and labels independently of grid.",
    showGrid:
      "Boolean, defaulttrue. Controls auxiliary grid lines on numeric axes; false hides them while leaving visible axes intact.",
    showLabels:
      "Boolean, defaultfalse. Values on bars or points; uses numberFormat, hides overlaps and omits nulls. Stacked labels show each segment's value, not cumulative totals.",
    labelPosition:
      "auto (default), outside or inside for bars. Auto places stacked bar values inside and other bars outside. Line/area/scatter labels sit above points. Long labels may truncate in narrow blocks; tooltip retains full value.",
    legend:
      "Required boolean. legendPosition top(default)/bottom/left/right; legendAlign start/center(default)/end.",
    numberFormat:
      "auto(default), integer, decimal(2 digits), percent(value*100) or compact. Applies to axes, values and tooltips; does not change stored rows.",
    sort: "none(default: SQL row order), asc or desc by category/X.",
    palette:
      "default, cool, warm or vivid. Palette changes keep explicit seriesColors overrides.",
    seriesColors:
      "Optional HEX map with stable series identities described below. To reset one color, remove that key from a copied map; send {} to reset all. Never use display names, row indexes or null as colors.",
  },
  palettes: CHART_PALETTES,
  seriesColors: {
    keyFormula:
      "JSON.stringify([metricColumnId, breakdownColumnId ?? null, rawGroupValue ?? null])",
    withoutBreakdown: "JSON.stringify([metricColumnId, null, null])",
    rawValues:
      "Use exact saved cell types from read_result: 1, '1', false, '' and null are distinct groups. Missing group is normalized to null. Keys survive row sorting and display-name changes; different metric/breakdown IDs are different series.",
    maxEntries: CHART_SERIES_COLOR_LIMIT,
    maxKeyLength: CHART_SERIES_COLOR_KEY_LIMIT,
    colorFormat:
      "#RRGGBB, case-insensitive; no alpha, named colors or short HEX.",
  },
  resize: {
    contract:
      "Width and height are top-level node fields in board coordinates, not data.chart and not screen pixels. Read actual node.width/height, fallback480/300 only if omitted. To preserve aspect ratio, multiply BOTH by the same positive scale s in one update_node patch. Chart UI minimum is280x180, saved maximum10000 each: clamp s jointly to [max(280/w,180/h), min(10000/w,10000/h)] before applying. If the interval is empty, keep existing dimensions and explain. Clamp floating-point overshoots at bounds. There is no persistent Shift/aspect-lock setting: Shift is a browser gesture; MCP achieves the same geometry by setting both dimensions.",
    anchor:
      "For bottom-right keep position unchanged. For a left corner use x'=x+w-w'; for a top corner y'=y+h-h'. Leave the other coordinate unchanged. Coordinates must remain within ±1000000. Keep data/chart/source untouched when resizing.",
    example: {
      before: { position: { x: 100, y: 200 }, width: 600, height: 400 },
      scale: 1.5,
      bottomRightPatch: { width: 900, height: 600 },
      topLeftPatch: { position: { x: -200, y: 0 }, width: 900, height: 600 },
    },
  },
  limits: {
    maxPoints: 5000,
    maxMetrics: 20,
    maxBoardNodes: 200,
    maxOperations: 200,
  },
  example: {
    columns: [
      { id: "month-id", name: "Month", type: "String" },
      { id: "revenue-id", name: "Revenue", type: "Float64" },
      { id: "channel-id", name: "Channel", type: "String" },
    ],
    rows: [
      ["October", 320, "Online"],
      ["October", 180, "Stores"],
    ],
    chart: example,
    operation: {
      type: "update_node",
      id: "<target-node-id>",
      patch: { data: { view: "chart", chart: example } },
    },
    note: "Illustrative IDs and rows only. Use verified IDs/current full chart in a real mutation; do not embed rows in board data.",
  },
};
