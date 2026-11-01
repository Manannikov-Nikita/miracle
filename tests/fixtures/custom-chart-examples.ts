import type { CustomChartSpec } from "../../src/shared/custom-charts";
import type { Cell, Column } from "../../src/shared/types";

export interface CustomChartExample {
  id: string;
  title: string;
  spec: CustomChartSpec;
  columns: Column[];
  rows: Cell[][];
  /** Portable literal-only SQL: deliberately synthetic, with stable column names. */
  sql: string;
}

const css = `
*{box-sizing:border-box}body{margin:0}#chart-root{height:100%;background:#fff;color:#142d33;font-family:Arial,sans-serif}
.chart{position:relative;min-height:100%;background:#fff}.chart svg{display:block;width:100%;height:auto;max-height:100%;font-family:Arial,sans-serif}
.toolbar{position:absolute;right:3%;top:18px;z-index:1}.toolbar button{border:1px solid #a5b6b8;border-radius:4px;background:#fff;color:#25454a;padding:7px 10px;font:12px Arial,sans-serif;cursor:pointer}
button:focus-visible,[data-mark]:focus{outline:3px solid #b06c18;outline-offset:3px}[data-mark]{cursor:help}[data-mark]:hover,[data-mark]:focus{stroke:#142d33;stroke-width:2}
.tooltip{display:block;position:absolute;left:4%;bottom:6px;max-width:90%;font-size:12px;color:#34575c;background:#fff}.empty{padding:100px 32px;color:#34575c}
`;
const html = `<section class="chart"><div class="toolbar"><button type="button" aria-pressed="true">Подписи значений</button></div><output class="tooltip" aria-live="polite"></output></section>`;

// These helpers become part of each saved body: there are no imports or hidden data at runtime.
const common = `
const host = api.root.querySelector('.chart');
const button = host.querySelector('button');
const tooltip = host.querySelector('output');
const ns = 'http://www.w3.org/2000/svg';
const svg = document.createElementNS(ns, 'svg');
svg.setAttribute('viewBox', '0 0 1000 650');
svg.setAttribute('role', 'img');
svg.setAttribute('aria-label', api.root.dataset.title || 'Синтетический учебный график');
host.append(svg);
function el(tag, attributes, text, parent = svg) {
  const node = document.createElementNS(ns, tag);
  for (const [key, value] of Object.entries(attributes || {})) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = String(text);
  parent.append(node); return node;
}
function text(x, y, value, extra = {}) { return el('text', {x, y, fill:'#25454a', 'font-size':14, ...extra}, value); }
function line(x1,y1,x2,y2,extra={}) { return el('line',{x1,y1,x2,y2,stroke:'#b9c8c9','stroke-width':1,...extra}); }
function index(id, name) {
  const found = api.columns.findIndex(column => column.id === id || column.name === name || column.name === id);
  if (found < 0) throw new Error('Отсутствует столбец: ' + id);
  return found;
}
// Explicit policy for these approximate teaching diagrams. Exact integers beyond the safe
// range are rejected; decimal strings use Number only after syntax and range checks.
function number(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)$/.test(value))) throw new Error('Ожидалось конечное число без пропусков');
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER) throw new Error('Число вне безопасного диапазона; агрегируйте или масштабируйте SQL');
  return n;
}
const format = value => new Intl.NumberFormat('ru-RU', {maximumFractionDigits:1}).format(value);
const cleanup = [];
function listen(node, event, handler) { node.addEventListener(event, handler); cleanup.push(() => node.removeEventListener(event, handler)); }
function mark(rect, label) {
  rect.setAttribute('tabindex','0'); rect.setAttribute('role','img'); rect.setAttribute('aria-label',label);
  el('title',{},label,rect);
  const show = () => { tooltip.textContent = label; };
  const hide = () => { tooltip.textContent = ''; };
  listen(rect,'mouseenter',show); listen(rect,'focus',show); listen(rect,'mouseleave',hide); listen(rect,'blur',hide);
}
listen(button,'click',() => {
  const visible = button.getAttribute('aria-pressed') !== 'true';
  button.setAttribute('aria-pressed',String(visible));
  svg.querySelectorAll('[data-value]').forEach(node => node.setAttribute('visibility',visible?'visible':'hidden'));
});
const finish = () => () => cleanup.forEach(stop => stop());
if (!api.rows.length) {
  text(45,65,'Синтетические данные · учебный пример',{'font-size':13});
  text(45,165,'Нет строк — обновите запрос или измените фильтр.',{'font-size':22});
  button.hidden = true;
  return finish();
}
`;

const verticalJavascript =
  common +
  `
const yi=index('year','Год'), vi=index('value','Изменение'), pi=index('phase','Этап');
const rows=api.rows.map(row=>({year:number(row[yi]), value:number(row[vi]), phase:String(row[pi])})).sort((a,b)=>a.year-b.year);
const colors=['#2b7579','#e4ad39','#9c4a42'];
const phases=[...new Set(rows.map(row=>row.phase))];
const color=phase=>colors[phases.indexOf(phase)%colors.length];
const left=100, right=905, zero=320, step=(right-left)/rows.length;
const maximum=Math.max(40,...rows.map(row=>Math.abs(row.value)));
const scale=170/maximum;
text(45,38,'УЧЕБНАЯ МОДЕЛЬ / 01',{'font-size':11,'letter-spacing':2,fill:'#607a7d'});
text(45,83,'Траектория изменений',{'font-size':32,'font-weight':700,fill:'#142d33'});
text(45,110,'Синтетические данные · условные единицы · не прогноз',{'font-size':14,fill:'#607a7d'});
phases.forEach((phase,i)=>{el('rect',{x:45+i*220,y:136,width:12,height:12,fill:color(phase)});text(65+i*220,147,phase,{'font-size':12});});
for(const tick of [-maximum, -maximum/2, 0, maximum/2, maximum]) {
 const y=zero-tick*scale; line(85,y,940,y,{stroke:tick===0?'#45686b':'#e7eeee','stroke-width':tick===0?1.5:1});
 text(72,y+4,format(tick),{'font-size':11,'text-anchor':'end',fill:'#6e8588'});
}
const positions = new Map();
rows.forEach((row,i)=>{
 const x=left+i*step+step*.2, width=step*.6, h=Math.abs(row.value)*scale;
 const y=row.value>=0?zero-h:zero;
 const rect=el('rect',{x,y,width,height:h,fill:color(row.phase),'data-mark':row.year});
 const label=String(row.year)+': '+format(row.value)+' усл. ед.; '+row.phase;
 mark(rect,label); positions.set(row.year,{x:x+width/2,y:zero-row.value*scale,value:row.value});
 text(x+width/2,row.value>=0?y-10:y+h+20,format(row.value),{'text-anchor':'middle','font-size':16,'font-weight':700,'data-value':''});
 text(x+width/2,532,String(row.year),{'text-anchor':'middle','font-size':13});
});
function callout(year, y, caption) {
 const point=positions.get(year); if(!point)return;
 const cy=y+24, direction=point.y>cy?1:-1;
 el('path',{d:'M '+point.x+' '+cy+' V '+(point.y-direction*7),fill:'none',stroke:'#496a6f','stroke-width':1.2,'stroke-dasharray':'3 3'});
 el('path',{d:'M '+(point.x-4)+' '+(point.y-direction*12)+' L '+point.x+' '+(point.y-direction*5)+' L '+(point.x+4)+' '+(point.y-direction*12),fill:'none',stroke:'#496a6f','stroke-width':1.3});
 text(point.x,y,format(point.value)+' усл. ед.',{'text-anchor':'middle','font-size':21,'font-weight':700,'data-callout':year});
 text(point.x,y+18,caption,{'text-anchor':'middle','font-size':11});
}
callout(2030,191,'Контрольная точка 2030');
callout(2050,475,'Контрольная точка 2050');
const bx1=left+step*.2, bx2=right-step*.2;
el('path',{d:'M '+bx1+' 553 V 561 H '+bx2+' V 553',fill:'none',stroke:'#789295','stroke-width':1.2});
text((bx1+bx2)/2,581,'Горизонт учебного сценария¹',{'text-anchor':'middle','font-size':12});
text(45,612,'¹ Все значения вымышлены. Знак показывает направление изменения относительно условного нуля.',{'font-size':11,fill:'#6e8588'});
return finish();
`;

const waterfallJavascript =
  common +
  `
const ci=index('category','Категория'), ai=index('amount','Объём'), gi=index('group','Группа');
const rows=api.rows.map(row=>({category:String(row[ci]),amount:number(row[ai]),group:String(row[gi])}));
if(rows.some(row=>row.amount<0))throw new Error('Этот учебный waterfall ожидает неотрицательные составляющие');
const total=rows.reduce((sum,row)=>sum+row.amount,0);
if(!Number.isFinite(total)||total>Number.MAX_SAFE_INTEGER)throw new Error('Итог вне безопасного диапазона');
const groups=[...new Set(rows.map(row=>row.group))];
const colors=['#2b7579','#dfab3a','#a35449'];
const color=group=>colors[groups.indexOf(group)%colors.length];
const left=285, plot=600, scale=plot/Math.max(total,1), top=167, step=34, bar=21;
text(45,38,'УЧЕБНАЯ МОДЕЛЬ / 02',{'font-size':11,'letter-spacing':2,fill:'#607a7d'});
text(45,83,'Из чего складывается объём',{'font-size':32,'font-weight':700,fill:'#142d33'});
text(45,110,'Синтетические данные · условная инфраструктура · усл. ед.',{'font-size':14,fill:'#607a7d'});
[0,.25,.5,.75,1].forEach(f=>{const x=left+plot*f;line(x,143,x,468,{stroke:'#e7eeee'});text(x,137,format(total*f),{'text-anchor':'middle','font-size':11,fill:'#6e8588'});});
let running=0;
rows.forEach((row,i)=>{
 const x=left+running*scale, y=top+i*step, width=row.amount*scale;
 text(265,y+15,row.category,{'text-anchor':'end','font-size':13});
 const rect=el('rect',{x,y,width,height:bar,fill:color(row.group),'data-mark':row.category});
 mark(rect,row.category+': '+format(row.amount)+' усл. ед.; '+row.group);
 text(x+width/2,y+15,format(row.amount),{'text-anchor':'middle','font-size':12,'font-weight':700,fill:width>35?'#fff':'#25454a','data-value':''});
 running+=row.amount;
 if(i<rows.length-1)line(left+running*scale,y+bar,left+running*scale,y+step,{'stroke-dasharray':'3 2',stroke:'#789295','data-connector':''});
});
line(45,466,945,466,{stroke:'#b9c8c9'});
text(265,502,'Общий объём',{'text-anchor':'end','font-size':15,'font-weight':700});
let grouped=0;
groups.forEach(group=>{
 const sum=rows.filter(row=>row.group===group).reduce((n,row)=>n+row.amount,0);
 const x=left+grouped*scale, width=sum*scale;
 const rect=el('rect',{x,y:481,width,height:32,fill:color(group)});mark(rect,group+': '+format(sum)+' усл. ед.');
 text(x+width/2,502,format(sum),{'data-total':group,'data-value':'','text-anchor':'middle','font-size':14,'font-weight':700,fill:'#fff'});
 grouped+=sum;
});
text(940,503,format(total),{'data-grand-total':'','text-anchor':'end','font-size':19,'font-weight':700});
groups.forEach((group,i)=>{el('rect',{x:285+i*210,y:533,width:10,height:10,fill:color(group)});text(301+i*210,542,group,{'font-size':11});});
el('path',{d:'M 285 562 V 569 H 885 V 562',fill:'none',stroke:'#789295'});
text(585,588,'Составной итог равен сумме всех категорий¹',{'text-anchor':'middle','font-size':12});
text(45,614,'¹ Учебные числа и категории вымышлены. Соединители показывают накопление, цвета — группы.',{'font-size':11,fill:'#6e8588'});
return finish();
`;

function literalSql(columns: Column[], rows: Cell[][]): string {
  const literal = (cell: Cell) =>
    typeof cell === "number"
      ? String(cell)
      : "'" + String(cell).replaceAll("'", "''") + "'";
  return (
    rows
      .map(
        (row) =>
          "SELECT " +
          row
            .map(
              (cell, index) =>
                literal(cell) +
                ' AS "' +
                columns[index].name.replaceAll('"', '""') +
                '"',
            )
            .join(", "),
      )
      .join("\nUNION ALL\n") + ";"
  );
}
function example(
  id: string,
  title: string,
  description: string,
  javascript: string,
  columns: Column[],
  rows: Cell[][],
): CustomChartExample {
  return {
    id,
    title,
    spec: { version: 1, description, html, css, javascript },
    columns,
    rows,
    sql: literalSql(columns, rows),
  };
}
export const verticalColumnsExample = example(
  "vertical-columns",
  "Учебная траектория",
  "Синтетический сценарий: положительные и отрицательные столбцы по годам, три цветных этапа, выноски на 2030 и 2050, стрелки, скобка и сноска. Числа вычисляются из снимка. Кнопка «Подписи значений» переключает числа; Tab переводит фокус по столбцам и показывает описание.",
  verticalJavascript,
  [
    { id: "year", name: "Год", type: "Int32" },
    { id: "value", name: "Изменение", type: "Float64" },
    { id: "phase", name: "Этап", type: "String" },
  ],
  [
    [2020, 32, "Подготовка"],
    [2025, 25, "Подготовка"],
    [2030, 18, "Переход"],
    [2035, 9, "Переход"],
    [2040, -6, "Изменение"],
    [2045, -14, "Изменение"],
    [2050, -23, "Изменение"],
  ],
);
export const infrastructureWaterfallExample = example(
  "infrastructure-waterfall",
  "Учебная инфраструктура",
  "Синтетический горизонтальный waterfall из восьми условных инфраструктурных категорий. Пунктирные соединители показывают накопление; итоговая полоса складывает группы строительства, инженерных систем и резерва. Все числа и размеры вычисляются из снимка. Подписи переключаются кнопкой, столбцы доступны по Tab с описанием.",
  waterfallJavascript,
  [
    { id: "category", name: "Категория", type: "String" },
    { id: "amount", name: "Объём", type: "Float64" },
    { id: "group", name: "Группа", type: "String" },
  ],
  [
    ["Подготовка площадки", 120, "Строительство"],
    ["Основания и опоры", 80, "Строительство"],
    ["Трассы и проезды", 45, "Строительство"],
    ["Общие конструкции", 60, "Строительство"],
    ["Энергоснабжение", 150, "Инженерные системы"],
    ["Вода и тепло", 75, "Инженерные системы"],
    ["Связь и управление", 30, "Инженерные системы"],
    ["Резерв развития", 440, "Резерв"],
  ],
);
export const customChartExamples = [
  verticalColumnsExample,
  infrastructureWaterfallExample,
];
