import {
  CUSTOM_CHART_LIMITS,
  type CustomChartSpec,
} from "../shared/custom-charts.js";

const example: CustomChartSpec = {
  version: 1,
  description:
    "Столбцы по label/value с положительными и отрицательными значениями. Кнопка скрывает или показывает числовые подписи; поддерживает клавиатуру.",
  html: "<div class='chart'></div>",
  css: ":host,body{margin:0} .chart{height:100%;background:#fff;color:#222;font:14px system-ui} svg{display:block;width:100%;height:100%} button{position:absolute;right:8px;top:8px} text{fill:#222;font:12px system-ui}",
  javascript: `const { root, columns, rows, width, height } = api;
const doc = root.ownerDocument;
root.style.background = '#fff';
root.style.color = '#222';
root.style.font = '14px system-ui';
root.style.position = 'relative';
const labelIndex = columns.findIndex(c => c.id === 'label' || c.name === 'label');
const valueIndex = columns.findIndex(c => c.id === 'value' || c.name === 'value');
if (labelIndex < 0 || valueIndex < 0) throw new Error('Ожидаются столбцы label и value');
// This example accepts numeric cells only. Exact-number strings stay strings;
// choose and document any conversion yourself after checking precision/range.
const points = rows.map(row => {
  const value = row[valueIndex];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('value должен быть конечным числом');
  return { label: String(row[labelIndex] ?? ''), value };
});
root.replaceChildren();
if (!points.length) {
  root.textContent = 'Нет данных';
  return () => root.replaceChildren();
}
const w = Math.max(160, width), h = Math.max(140, height);
const ns = 'http://www.w3.org/2000/svg';
const make = (tag, attrs, text) => {
  const element = doc.createElementNS(ns, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
};
const svg = make('svg', { viewBox: '0 0 ' + w + ' ' + h, role: 'img', 'aria-label': 'Значения по категориям' });
root.append(svg);
const extent = Math.max(1, ...points.map(point => Math.abs(point.value)));
const baseline = h / 2, scale = (h / 2 - 42) / extent;
const step = (w - 48) / points.length;
svg.append(make('line', { x1: 24, x2: w - 24, y1: baseline, y2: baseline, stroke: '#555' }));
const labels = [];
points.forEach((point, index) => {
  const x = 24 + index * step, barHeight = Math.abs(point.value) * scale;
  const top = point.value >= 0 ? baseline - barHeight : baseline;
  const bar = make('rect', { x: x + 4, y: top, width: Math.max(1, step - 8), height: barHeight, fill: point.value >= 0 ? '#277b69' : '#b74c42' });
  bar.append(make('title', {}, point.label + ': ' + point.value));
  svg.append(bar, make('text', { x: x + step / 2, y: h - 12, 'text-anchor': 'middle' }, point.label));
  const label = make('text', { x: x + step / 2, y: point.value >= 0 ? top - 6 : top + barHeight + 16, 'text-anchor': 'middle' }, String(point.value));
  labels.push(label);
  svg.append(label);
});
const button = doc.createElement('button');
button.type = 'button';
button.textContent = 'Скрыть значения';
button.setAttribute('aria-pressed', 'false');
let hidden = false;
const toggle = () => {
  hidden = !hidden;
  labels.forEach(label => label.style.display = hidden ? 'none' : '');
  button.setAttribute('aria-pressed', String(hidden));
  button.textContent = hidden ? 'Показать значения' : 'Скрыть значения';
};
button.addEventListener('click', toggle);
root.append(button);
return () => {
  button.removeEventListener('click', toggle);
  root.replaceChildren();
};`,
};

export const customChartGuide = {
  version: 1,
  contract:
    "Create kind:'result', view:'custom', resultSetId, SQL source and customChart:{version:1,description,html,css,javascript} through board_patch. javascript is the synchronous body of function(api); it may return a cleanup function. api={root:HTMLElement,columns:Column[],rows:Cell[][],width:number,height:number,theme:'dark'|'light'}. Column={id,name,type}; cells retain exact strings and nulls. Bind by verified column ID/name, handle missing columns and empty rows explicitly. Use root.ownerDocument for DOM/SVG. Do not embed snapshot rows in source.",
  limits: CUSTOM_CHART_LIMITS,
  environment:
    "Standard DOM, SVG and Canvas only; no libraries/CDNs, SQL execution, parent DOM/storage or application API bridge. Opaque iframe sandbox allow-scripts; CSP blocks external subresources. Source never executes in the parent or server. No guarantee of CPU quotas/process separation or universal prevention of iframe navigation/outgoing channels; this is not a hostile-code runtime. Inline styles and data: images are available. No image uploads, export, multiple SQL sources or persistent interactive state.",
  lifecycle:
    "Code, snapshot, theme or debounced board-coordinate size changes restart the iframe with current api values. Zoom alone should not restart it. Use width/height or SVG viewBox. Register local pointer/keyboard handlers and return cleanup to remove handlers/timers. Async event handlers may run after synchronous initialization; global errors and unhandled Promise rejections are diagnostic errors. Transient interaction state resets on restart. Give controls labels and keyboard access; description is the textual alternative.",
  workflow:
    "Read the selected node with read_board first; for large source use format:'json' and follow nextOffset while checking revision. Inspect schema/result columns and bounded rows, run SQL, then attach a completed snapshot. Keep the selected node ID; never replace a missing target with another block. Read current revision before each intended mutation; use a fresh UUID mutationId, reusing it only for retry of identical input. On REVISION_CONFLICT reread before revising. Split large edits into separate operations under the 2 MiB HTTP limit, but the complete board containing customChart must fit 1.5 MiB UTF-8 even in table mode. Aggregate SQL when data limits are exceeded; data are never truncated or converted implicitly. Snapshot refresh retains saved source; switching view:'table' retains customChart.",
  diagnostics:
    "After saving use read_custom_chart_status({id:boardId,nodeId}). Aggregate status covers all fresh browser reports matching current spec hash and snapshot, with error > rendering > rendered; report details are paginated with offset/limit (default 10, maximum 20), total and nextOffset. Follow nextOffset until null to inspect every tab; no report is not_observed, never success. Reports expire after 60 seconds. Reports carry a parent-created sentAt timestamp unchanged across request retries; payloads aged 60 seconds or more and future skew above 5 seconds are rejected. The 1000-entry in-memory registry rejects new sessions with 429 when full, while existing observations keep updating. rendered only means synchronous initialization finished; it does not prove visual correctness. Fix reported runtime errors with at most 3 attempts, rereading the current node/revision each time; stop and explain any unresolved error. A closed board can be saved but cannot be described as browser-verified. Never claim visual correctness from rendered alone. Do not include code or data rows in diagnostics.",
  example,
};
