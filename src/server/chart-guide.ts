import { z } from "zod";
import { chartSpecSchema } from "../shared/board-schema.js";
import { DEFAULT_CHART_SIZE } from "../shared/chart-size.js";
import {
  CHART_PALETTES,
  CHART_POINT_LIMIT,
  CHART_METRIC_LIMIT,
  CHART_MARK_RULE_LIMIT,
  CHART_SERIES_COLOR_KEY_LIMIT,
  CHART_SERIES_COLOR_LIMIT,
  chartSeriesColorKey,
  unfinishedPeriodRule,
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
    binCount: {
      ...propertySchema("binCount"),
      description:
        "Histogram only. Set an integer from 1 to 100 to choose the number of equal-width intervals. Omit for automatic binning.",
    },
    showTotals: {
      ...propertySchema("showTotals"),
      description:
        "Stack totals, independent of segment labels. Defaults to true for bar charts with stacked:true and a series breakdown. Set false to hide; ignored for other chart types and non-stacked charts.",
    },
    metricStyles: {
      ...propertySchema("metricStyles"),
      maxProperties: CHART_METRIC_LIMIT,
      description:
        "Composed charts only. Map numeric metric column IDs to bar, line or area. Without an override the first metric uses bars and subsequent metrics use lines. Each breakdown of a metric shares its mark.",
    },
    seriesColors: {
      ...propertySchema("seriesColors"),
      maxProperties: CHART_SERIES_COLOR_LIMIT,
      description:
        "HEX colors keyed by JSON.stringify([metricColumnId, breakdownColumnId ?? null, rawGroupValue ?? null]); without breakdown use [metricColumnId,null,null]. Histograms use the observation column ID (x) as the metric ID. Preserve raw group types. Empty object resets all overrides.",
    },
    seriesStyles: {
      ...propertySchema("seriesStyles"),
      maxProperties: CHART_SERIES_COLOR_LIMIT,
      description:
        "Per-series paint, keyed with the seriesColors key formula. All paint fields are optional. Styles apply to a whole line or breakdown, including marks without a matching rule.",
    },
    markRules: {
      ...propertySchema("markRules"),
      description:
        "Ordered per-mark rules for all eight native chart types. Optionally restrict a rule to a seriesKey. Later matching rules override only the style fields they set. See chart_guide.markAppearance for positions and source column examples.",
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
    kind: "bar, line, area, scatter, composed, sparkline, heatmap or histogram. orientation vertical/horizontal applies only to bar. Sparkline displays compact trends without axes. Heatmap places categories on X and each metric/breakdown on Y; cell intensity follows its numeric value. Supply one row per category and breakdown.",
    binCount:
      "For a histogram, bind x to the numeric observation column and send y: []. Frequencies count non-null observations after table transformations. A series breakdown uses common bin edges for all groups. Groups overlap by default; set stacked:true to accumulate counts. Omit binCount for automatic binning or set an integer from 1 to 100. sort does not affect interval order.",
    metricStyles:
      "For composed charts, use metric column IDs as keys with bar, line or area values. The first metric defaults to bar and others to line.",
    x: "Category column ID; scatter and histogram require a numeric X column. On horizontal bars this category is placed on physical Y.",
    y: "Array of numeric metric column IDs, up to20. Use [] for histograms, which compute their own Y counts. Other kinds need at least one metric to render.",
    series:
      "Optional breakdown column ID. Omit to remove breakdown; do not send null.",
    stacked:
      "Stack breakdown groups within each metric; requires series and applies to bar/line/area. On histograms, stacking adds group counts in each bin. Scatter ignores it. For bar/line/area stacking SQL must supply one row per category/group. Histogram input contains one row per observation.",
    showXAxis:
      "Boolean, defaulttrue. Hide/show physical X axis name, ticks and labels independently of grid, including on horizontal bars.",
    showYAxis:
      "Boolean, defaulttrue. Hide/show physical Y axis name, ticks and labels independently of grid.",
    showGrid:
      "Boolean, defaulttrue. Controls auxiliary grid lines on numeric axes; false hides them while leaving visible axes intact.",
    showLabels:
      "Boolean, defaultfalse. Values on bars, points or heatmap cells. Sparkline labels its latest value. Uses numberFormat, hides overlaps and omits nulls. Stacked labels show each segment's value, not cumulative totals.",
    showTotals:
      "Boolean, defaulttrue for bar with stacked:true and a series breakdown. Shows stack totals independently of showLabels. Set false to hide; ignored for other chart types and non-stacked charts. The preference is retained when switching chart types.",
    labelPosition:
      "auto (default), outside or inside for bars. Auto places stacked bar values inside and other bars outside. Line/area/scatter labels sit above points. Long labels may truncate in narrow blocks; tooltip retains full value.",
    legend:
      "Required boolean. On charts with a legend, legendPosition is top (default), bottom, left or right and legendAlign is start, center (default) or end. For histograms these fields retain preferences for other chart types. Histograms show every distribution and identify its color and count in the bin tooltip.",
    numberFormat:
      "auto(default), integer, decimal(2 digits), percent(value*100) or compact. Applies to axes, values and tooltips; does not change stored rows.",
    sort: "none(default: SQL row order), asc or desc by category/X.",
    palette:
      "default, cool, warm or vivid. Palette changes keep explicit seriesColors overrides.",
    seriesColors:
      "Optional HEX map with stable series identities described below. To reset one color, remove that key from a copied map; send {} to reset all. Never use display names, row indexes or null as colors.",
    seriesStyles:
      "Optional map from the same stable series keys to partial mark styles. Remove individual properties to inherit them, or remove a key to reset the series.",
    markRules:
      "Ordered array of conditional mark styles. Each rule targets all series or one seriesKey. Reorder for priority; omit or send [] to clear all.",
  },
  markAppearance: {
    style:
      "color and borderColor use #RRGGBB. opacity is 0..1 (0 is transparent); borderWidth is 0..8 plot pixels; borderStyle is solid, dashed or dotted. pattern is none, diagonal, crosshatch or dots. A zero-width border removes the outline. Line color and outline are independent. Heatmap fill opacity scales its value-based intensity; missing cells retain their empty appearance.",
    precedence:
      "Paint starts with the palette or seriesColors and any table cell color. seriesStyles and then matching markRules override individual properties. The last matching explicit value for a property wins. Hide/show of a series keeps its identity.",
    position:
      "first/last on categorical charts selects the first/last displayed X category across breakdowns after sorting. Sparkline uses the first/last slot of each row; scatter selects all points tied at its series' minimum/maximum numeric X. Histogram uses the first/last bin. Missing marks are never created. Rules are reevaluated on refresh.",
    conditions:
      "field:'value' compares the plotted metric (before stacking) or histogram frequency. field:'x' compares raw X or a histogram bin's lower edge. field:'column' requires the columnId of a field in the transformed chart input, for example a status flag from SQL. A histogram bin aggregates observations and therefore supports position, x and value. Unknown columns and non-scalar cells do not match. Compare numeric columns as decimals, dates as dates, text and booleans with their native types. Use eq/ne and null for missing fields in an existing observation.",
    lines:
      "On lines, sparklines and area charts a conditional point style also paints the incoming segment, up to the matching point. A series style covers the entire line. Gaps stay open.",
    unfinishedPeriod: unfinishedPeriodRule,
    statusFlag: {
      when: {
        field: "column",
        columnId: "period_complete",
        op: "eq",
        value: false,
      },
      style: { pattern: "diagonal", borderStyle: "dashed" },
    },
    seriesExample: {
      [chartSeriesColorKey("plan", undefined, undefined)]: {
        color: "#82AAFF",
        opacity: 0.8,
        borderColor: "#365E8C",
        borderWidth: 1,
        borderStyle: "dotted",
      },
    },
    maxRules: CHART_MARK_RULE_LIMIT,
  },
  histogram: {
    automaticBins:
      "Automatic binning uses Sturges' rule as a target and rounds the interval step to readable decimal boundaries. Set binCount to choose the number explicitly.",
    example: {
      kind: "histogram",
      x: "duration_ms",
      y: [],
      series: "channel",
      legend: false,
      binCount: 20,
    },
    formatting:
      "numberFormat applies to interval boundaries. The vertical axis and value labels show integer counts.",
    limits:
      "Reads the full table snapshot, up to 50,000 input rows, 1,000,000 cells and 20 MiB. Up to 5,000 resulting bin/group counts.",
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
    defaultNewChartSize: DEFAULT_CHART_SIZE,
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
    maxPoints: CHART_POINT_LIMIT,
    maxMetrics: CHART_METRIC_LIMIT,
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
