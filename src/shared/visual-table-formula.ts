import type { VisualTableColumn } from "./visual-table.js";

export type VisualFormulaNode =
  | { kind: "column"; id: string }
  | { kind: "number"; value: string }
  | { kind: "literal"; value: string | boolean | null }
  | { kind: "unary"; op: "+" | "-"; value: VisualFormulaNode }
  | {
      kind: "binary";
      op: string;
      left: VisualFormulaNode;
      right: VisualFormulaNode;
    }
  | { kind: "call"; name: string; args: VisualFormulaNode[]; window: boolean };

type Token = {
  kind: "name" | "number" | "string" | "symbol";
  value: string;
  start: number;
  end: number;
  quoted?: boolean;
};
const scalarFunctions = new Set([
  "abs",
  "round",
  "ceil",
  "floor",
  "sqrt",
  "power",
  "coalesce",
  "nullif",
  "lower",
  "upper",
  "length",
  "trim",
  "concat",
  "if",
  "greatest",
  "least",
]);
export const visualTableAggregateFunctions = new Set([
  "sum",
  "avg",
  "min",
  "max",
  "count",
]);
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < source.length;) {
    if (/\s/u.test(source[i])) {
      i++;
      continue;
    }
    const start = i;
    const rest = source.slice(i);
    const numeric = rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (numeric) {
      i += numeric[0].length;
      tokens.push({ kind: "number", value: numeric[0], start, end: i });
      continue;
    }
    if (["[", '"', "'"].includes(source[i])) {
      const open = source[i++],
        close = open === "[" ? "]" : open;
      let value = "",
        closed = false;
      while (i < source.length) {
        if (source[i] === close) {
          if (source[i + 1] === close) {
            value += close;
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        value += source[i++];
      }
      if (!closed) throw new Error("Закройте кавычку или скобку в формуле.");
      tokens.push({
        kind: open === "'" ? "string" : "name",
        value,
        start,
        end: i,
        quoted: true,
      });
      continue;
    }
    const name = rest.match(/^[\p{L}_][\p{L}\p{N}_]*/u);
    if (name) {
      i += name[0].length;
      tokens.push({ kind: "name", value: name[0], start, end: i });
      continue;
    }
    const symbol = rest.match(/^(?:<=|>=|!=|<>|[+*/%,()=<>-])/);
    if (!symbol)
      throw new Error(`Неподдерживаемый символ в формуле: ${source[i]}`);
    i += symbol[0].length;
    tokens.push({ kind: "symbol", value: symbol[0], start, end: i });
  }
  return tokens;
}
function resolveColumn(value: string, columns: VisualTableColumn[]) {
  return (
    columns.find(
      (c) => c.name.toLocaleLowerCase() === value.toLocaleLowerCase(),
    ) ?? columns.find((c) => c.id === value)
  );
}
export function parseVisualTableFormula(
  formula: string,
  columns: VisualTableColumn[],
): VisualFormulaNode {
  if (formula.length > 2000)
    throw new Error("Формула превышает 2 000 символов.");
  const tokens = tokenize(formula.trim().replace(/^=/, ""));
  let position = 0,
    depth = 0;
  const priority: Record<string, number> = {
    "=": 1,
    "!=": 1,
    "<>": 1,
    "<": 1,
    ">": 1,
    "<=": 1,
    ">=": 1,
    "+": 2,
    "-": 2,
    "*": 3,
    "/": 3,
    "%": 3,
  };
  const take = (value: string) =>
    tokens[position]?.kind === "symbol" &&
    tokens[position]?.value === value &&
    (position++, true);
  function primary(): VisualFormulaNode {
    if (++depth > 64) throw new Error("Формула слишком сложная.");
    try {
      for (const op of ["+", "-"] as const)
        if (take(op)) return { kind: "unary", op, value: primary() };
      if (take("(")) {
        const value = parse(0);
        if (!take(")")) throw new Error("Закройте скобку в формуле.");
        return value;
      }
      const token = tokens[position++];
      if (!token) throw new Error("Завершите выражение.");
      if (token.kind === "number")
        return { kind: "number", value: token.value };
      if (token.kind === "string")
        return { kind: "literal", value: token.value };
      if (token.kind !== "name")
        throw new Error(
          `Ожидалось имя столбца, число или функция: ${token.value}`,
        );
      if (!token.quoted && take("(")) {
        const name = token.value.toLowerCase();
        if (
          !scalarFunctions.has(name) &&
          !visualTableAggregateFunctions.has(name)
        )
          throw new Error(`Функция ${token.value} не поддерживается.`);
        const args: VisualFormulaNode[] = [];
        if (!take(")")) {
          if (name === "count" && take("*"))
            args.push({ kind: "number", value: "1" });
          else
            do {
              args.push(parse(0));
            } while (take(","));
          if (!take(")")) throw new Error("Проверьте аргументы функции.");
        }
        if (!args.length || args.length > 20)
          throw new Error("Проверьте количество аргументов функции.");
        return {
          kind: "call",
          name,
          args,
          window: visualTableAggregateFunctions.has(name),
        };
      }
      if (
        !token.quoted &&
        ["null", "true", "false"].includes(token.value.toLowerCase())
      )
        return {
          kind: "literal",
          value:
            token.value.toLowerCase() === "null"
              ? null
              : token.value.toLowerCase() === "true",
        };
      const column = resolveColumn(token.value, columns);
      if (!column) throw new Error(`Нет столбца «${token.value}».`);
      return { kind: "column", id: column.id };
    } finally {
      depth--;
    }
  }
  function parse(min: number): VisualFormulaNode {
    let left = primary();
    while (position < tokens.length) {
      const token = tokens[position],
        level = token.kind === "symbol" ? (priority[token.value] ?? -1) : -1;
      if (level < min) break;
      position++;
      left = { kind: "binary", op: token.value, left, right: parse(level + 1) };
    }
    return left;
  }
  const node = parse(0);
  if (position < tokens.length)
    throw new Error(`Неожиданная часть формулы: ${tokens[position].value}`);
  return node;
}
export function visualFormulaDependencies(node: VisualFormulaNode): string[] {
  switch (node.kind) {
    case "column":
      return [node.id];
    case "unary":
      return visualFormulaDependencies(node.value);
    case "binary":
      return [
        ...visualFormulaDependencies(node.left),
        ...visualFormulaDependencies(node.right),
      ];
    case "call":
      return node.args.flatMap(visualFormulaDependencies);
    default:
      return [];
  }
}
export function renameVisualFormulaReferences(
  formula: string,
  columns: VisualTableColumn[],
  id: string,
  name: string,
): string {
  const tokens = tokenize(formula);
  let result = "",
    offset = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (
      token.kind !== "name" ||
      (!token.quoted &&
        (tokens[index + 1]?.value === "(" ||
          ["null", "true", "false"].includes(token.value.toLowerCase()))) ||
      resolveColumn(token.value, columns)?.id !== id
    )
      continue;
    result +=
      formula.slice(offset, token.start) + `[${name.replaceAll("]", "]]")}]`;
    offset = token.end;
  }
  return result + formula.slice(offset);
}
