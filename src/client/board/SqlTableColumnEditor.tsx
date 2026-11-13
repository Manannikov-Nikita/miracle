import { useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { Trash } from "@phosphor-icons/react";
import {
  renameVisualTableColumn,
  visualTableSpecSchema,
  VISUAL_TABLE_LIMITS,
  type VisualTableColumn,
  type VisualTableSpec,
} from "../../shared/visual-table";
import {
  parseVisualTableFormula,
  renameVisualFormulaReferences,
  visualFormulaDependencies,
} from "../../shared/visual-table-formula";
import { evaluateVisualTable } from "../api";
import { Modal } from "../components/UI";
import "./sql-table-column-editor.css";

type Props = {
  spec: VisualTableSpec;
  columnId?: string;
  onSave: (column: VisualTableColumn) => void;
  onClose: () => void;
  onRemove?: (columnId: string) => boolean | void;
};
const summaries = {
  none: "Без итога",
  sum: "Сумма",
  avg: "Среднее",
  min: "Минимум",
  max: "Максимум",
  count: "Количество",
};
function nextColumnName(spec: VisualTableSpec) {
  let index = spec.columns.length + 1;
  while (spec.columns.some((column) => column.name === `Столбец ${index}`))
    index++;
  return `Столбец ${index}`;
}

/** Drafts remain local until the complete candidate passes the existing DuckDB evaluator. */
export default function SqlTableColumnEditor({
  spec,
  columnId,
  onSave,
  onClose,
  onRemove,
}: Props) {
  const initial = useRef(spec.columns.find((column) => column.id === columnId));
  const [id] = useState(() => columnId ?? crypto.randomUUID());
  const [name, setName] = useState(
    () => initial.current?.name ?? nextColumnName(spec),
  );
  const [formula, setFormula] = useState(initial.current?.formula ?? "");
  const [type, setType] = useState<VisualTableColumn["type"]>(
    initial.current?.type ?? "number",
  );
  const [summary, setSummary] = useState<
    NonNullable<VisualTableColumn["summary"]>
  >(initial.current?.summary ?? "none");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  const closed = useRef(false);
  const editor = useRef<Parameters<OnMount>[0] | null>(null);
  const source = Boolean(initial.current?.sourceColumnId);
  const latestSpec = useRef(spec);
  latestSpec.current = spec;

  useEffect(() => {
    // A concurrent document edit invalidates a pending validation, never the user's draft.
    request.current?.abort();
    request.current = undefined;
    setSaving(false);
  }, [spec]);
  useEffect(
    () => () => {
      request.current?.abort();
    },
    [],
  );

  const invalidate = () => {
    request.current?.abort();
    request.current = undefined;
    setSaving(false);
    setError(undefined);
  };
  const close = () => {
    closed.current = true;
    request.current?.abort();
    onClose();
  };
  const save = async () => {
    if (saving || closed.current) return;
    try {
      const current = latestSpec.current;
      const existing = current.columns.find((column) => column.id === id);
      if (columnId && !existing)
        throw new Error(
          "Этот столбец уже удалён. Закройте редактор и откройте таблицу заново.",
        );
      if (!name.trim()) throw new Error("Введите название столбца.");
      if (!columnId && !formula.trim())
        throw new Error("Введите SQL-выражение для нового столбца.");
      const renamed = existing
        ? renameVisualTableColumn(current, id, name.trim())
        : current;
      const nextFormula = source
        ? renamed.columns.find((item) => item.id === id)?.formula
        : existing
          ? renameVisualFormulaReferences(
              formula.trim(),
              current.columns,
              id,
              name.trim(),
            ) || undefined
          : formula.trim() || undefined;
      const column: VisualTableColumn = {
        ...existing,
        id,
        name: name.trim(),
        type: source ? existing!.type : type,
        formula: nextFormula,
        summary,
      };
      const parsed = visualTableSpecSchema.safeParse({
        ...renamed,
        columns: existing
          ? renamed.columns.map((item) => (item.id === id ? column : item))
          : [...renamed.columns, column],
      });
      if (!parsed.success) throw new Error(parsed.error.issues[0].message);
      const candidate = parsed.data;
      for (const item of candidate.columns) {
        if (item.formula?.trim())
          parseVisualTableFormula(item.formula, candidate.columns);
      }
      const controller = new AbortController();
      request.current?.abort();
      request.current = controller;
      setSaving(true);
      setError(undefined);
      try {
        await evaluateVisualTable(
          {
            table: candidate,
            resultSetId: candidate.sourceResultSetId,
            offset: 0,
            limit: 1,
          },
          controller.signal,
        );
        if (
          controller.signal.aborted ||
          closed.current ||
          request.current !== controller
        )
          return;
        onSave(candidate.columns.find((item) => item.id === id)!);
      } catch (failure) {
        if (
          !controller.signal.aborted &&
          !closed.current &&
          request.current === controller
        )
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      } finally {
        if (request.current === controller) {
          request.current = undefined;
          setSaving(false);
        }
      }
    } catch (failure) {
      if (
        !closed.current &&
        !(failure instanceof DOMException && failure.name === "AbortError")
      )
        setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  const remove = () => {
    if (!onRemove || closed.current) return;
    invalidate();
    try {
      const current = latestSpec.current;
      const column = current.columns.find((item) => item.id === id);
      if (!column) throw new Error("Этот столбец уже удалён.");
      if (column.sourceColumnId || current.columns.length <= 1)
        throw new Error("Этот столбец нельзя удалить.");
      const dependents = current.columns.filter((item) =>
        item.id !== id && item.formula?.trim()
          ? visualFormulaDependencies(
              parseVisualTableFormula(item.formula, current.columns),
            ).includes(id)
          : false,
      );
      if (dependents.length)
        throw new Error(
          `Столбец используется в формулах: ${dependents.map((item) => `«${item.name}»`).join(", ")}. Сначала измените эти выражения.`,
        );
      closed.current = true;
      if (onRemove(id) === false) closed.current = false;
    } catch (failure) {
      closed.current = false;
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const insertColumn = (column: VisualTableColumn) => {
    const text = `"${column.name.replaceAll('"', '""')}"`;
    invalidate();
    const selection = editor.current?.getSelection();
    if (editor.current && selection) {
      editor.current.executeEdits("column-reference", [
        { range: selection, text, forceMoveMarkers: true },
      ]);
      editor.current.focus();
    } else setFormula((value) => value + text);
  };
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={columnId ? "Настройки столбца" : "Новый столбец"}
      className="sql-column-editor"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.preventDefault();
            close();
          }
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void save();
          }
        }}
      >
        <div className="sql-column-fields">
          <label>
            <span>Название</span>
            <input
              aria-label="Название столбца"
              value={name}
              maxLength={200}
              onChange={(event) => {
                invalidate();
                setName(event.target.value);
              }}
            />
          </label>
          <label>
            <span>Тип значений</span>
            <select
              aria-label="Тип столбца"
              value={type}
              disabled={source}
              onChange={(event) => {
                invalidate();
                const value = event.target.value as VisualTableColumn["type"];
                setType(value);
                if (value !== "number" && ["sum", "avg"].includes(summary))
                  setSummary("none");
              }}
            >
              <option value="number">Число</option>
              <option value="text">Текст</option>
              <option value="boolean">Да / нет</option>
            </select>
          </label>
          <label>
            <span>Итог внизу таблицы</span>
            <select
              aria-label="Итог столбца"
              value={summary}
              onChange={(event) => {
                invalidate();
                setSummary(event.target.value as typeof summary);
              }}
            >
              {Object.entries(summaries)
                .filter(
                  ([value]) =>
                    type === "number" || !["sum", "avg"].includes(value),
                )
                .map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <div className="sql-column-expression-label">
          <span>SQL-выражение</span>
          <span>
            {source ? "Данные SQL · только чтение" : "Для всех строк"}
          </span>
        </div>
        <div className="sql-column-expression">
          <Editor
            language="sql"
            theme="miracle-dark"
            value={formula}
            onChange={(value) => {
              if (!source) {
                invalidate();
                setFormula(value ?? "");
              }
            }}
            onMount={(instance, monaco) => {
              editor.current = instance;
              instance.addCommand(
                monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
                () => {
                  void saveRef.current();
                },
              );
              if (!columnId) instance.focus();
            }}
            loading={
              <div className="sql-column-loading">Загрузка редактора…</div>
            }
            options={{
              ariaLabel: "SQL-выражение столбца",
              readOnly: source,
              fontSize: 14,
              fontFamily: '"JetBrains Mono", ui-monospace, monospace',
              lineHeight: 24,
              minimap: { enabled: false },
              automaticLayout: true,
              scrollBeyondLastLine: false,
              wordWrap: "on",
              padding: { top: 16, bottom: 16 },
              tabSize: 2,
              stickyScroll: { enabled: false },
            }}
          />
        </div>
        {!source && (
          <div className="sql-column-references">
            <span>Вставить столбец</span>
            <div>
              {spec.columns
                .filter((column) => column.id !== id)
                .map((column) => (
                  <button
                    type="button"
                    key={column.id}
                    onClick={() => insertColumn(column)}
                  >
                    {column.name}
                  </button>
                ))}
            </div>
          </div>
        )}
        <p className="sql-column-hint">
          {source
            ? "Значения и тип исходного SQL-столбца защищены. Для вычислений добавьте новый столбец."
            : 'Например: "Количество" * "Цена". Доступны арифметика, сравнения, IF, COALESCE, SUM и AVG.'}
          {!source && (
            <span>
              {formula.length.toLocaleString("ru-RU")} /{" "}
              {VISUAL_TABLE_LIMITS.formulaLength.toLocaleString("ru-RU")}
            </span>
          )}
        </p>
        {error && (
          <div className="sql-column-error" role="alert">
            {error}
          </div>
        )}
        <div className="sql-column-actions">
          {columnId && !source && spec.columns.length > 1 && onRemove && (
            <button
              type="button"
              className="sql-column-remove"
              onClick={remove}
            >
              <Trash size={15} />
              Удалить столбец
            </button>
          )}
          <button type="button" onClick={close}>
            Отмена
          </button>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? "Проверка…" : columnId ? "Сохранить" : "Добавить столбец"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
