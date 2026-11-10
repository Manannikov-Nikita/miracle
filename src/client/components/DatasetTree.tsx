import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowClockwise,
  CaretRight,
  Code,
  DotsThree,
  Pencil,
  Table,
  Trash,
} from "@phosphor-icons/react";
import type { Dataset } from "../../shared/datasets";
import type { QuerySource } from "../../shared/types";
import { api, json } from "../api";
import {
  datasetPath,
  useDatasetCatalog,
  type DatasetRevision,
} from "../dataset-catalog";
import { datasetQuery } from "../dataset-sql";
import { describeError } from "../error-message";
import DatasetNameDialog from "./DatasetNameDialog";
import DatasetRefreshStatus from "./DatasetRefreshStatus";
import SearchHighlight from "./SearchHighlight";
import { ErrorBox, IconButton, Modal, Spinner } from "./UI";
import "./dataset-tree.css";

export default function DatasetTree({
  filter,
  onOpenSource,
}: {
  filter: string;
  onOpenSource(
    source: QuerySource,
    name: string,
    dataset?: DatasetRevision,
  ): void;
}) {
  const catalog = useDatasetCatalog();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [dialog, setDialog] = useState<{
    action: "rename" | "delete";
    dataset: Dataset;
  }>();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  if (!catalog) return null;
  const { items, loading } = catalog;
  const search = filter.trim().toLocaleLowerCase();
  const matches = (value: string) => value.toLocaleLowerCase().includes(search);
  const filtered = items.filter(
    (dataset) =>
      matches(dataset.name) ||
      dataset.columns.some((column) =>
        matches(`${column.name} ${column.sourceName} ${column.duckdbType}`),
      ),
  );
  const close = () => {
    setDialog(undefined);
    setError("");
  };
  const remove = async (dataset: Dataset) => {
    if (deleting) return;
    setDeleting(true);
    setError("");
    try {
      await api(datasetPath(dataset.id), {
        method: "DELETE",
        body: json({
          baseRevision: dataset.revision,
          mutationId: crypto.randomUUID(),
        }),
      });
      await catalog.reload();
      close();
    } catch (error) {
      setError(describeError(error).details);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <div className="explorer-section-label schema-label">
        ДАТАСЕТЫ <span>{filtered.length}</span>
      </div>
      {loading && !items.length && (
        <div className="explorer-loading" role="status">
          <Spinner /> Загружаем датасеты…
        </div>
      )}
      {catalog.error && (
        <ErrorBox
          className="explorer-error"
          error={catalog.error}
          title="Не удалось загрузить датасеты."
          actions={
            <button
              type="button"
              className="text-button"
              onClick={() => void catalog.reload()}
            >
              Повторить
            </button>
          }
        />
      )}
      {!loading && !catalog.error && !filtered.length && (
        <p className="project-tree-note">
          {search
            ? "Датасеты не найдены."
            : "Добавьте результат запроса на доску, чтобы создать датасет."}
        </p>
      )}
      {filtered.map((dataset) => {
        const open = expanded[dataset.id] ?? Boolean(search);
        const refreshing = catalog.refreshes[dataset.id];
        return (
          <div key={dataset.id}>
            <div className="dataset-tree-row">
              <button
                type="button"
                className="schema-tree-item"
                aria-expanded={open}
                title={dataset.name}
                onClick={() =>
                  setExpanded((current) => ({
                    ...current,
                    [dataset.id]: !open,
                  }))
                }
              >
                <CaretRight
                  size={12}
                  className={open ? "dataset-tree-expanded" : ""}
                  aria-hidden="true"
                />
                <Table size={14} aria-hidden="true" />
                <span>
                  <SearchHighlight text={dataset.name} query={filter} />
                </span>
              </button>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <IconButton label={`Действия датасета ${dataset.name}`}>
                    <DotsThree size={17} />
                  </IconButton>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    className="dropdown-menu"
                    align="start"
                    sideOffset={4}
                  >
                    <DropdownMenu.Item
                      onSelect={() =>
                        onOpenSource(
                          datasetQuery(dataset.name),
                          `${dataset.name}.sql`,
                        )
                      }
                    >
                      <Code size={15} /> Написать запрос
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      onSelect={() =>
                        onOpenSource(
                          dataset.source,
                          `${dataset.name}_source.sql`,
                          { id: dataset.id, revision: dataset.revision },
                        )
                      }
                    >
                      <Code size={15} /> Редактировать исходный SQL
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      disabled={
                        catalog.recovering ||
                        refreshing?.busy ||
                        !!refreshing?.run
                      }
                      onSelect={() => void catalog.refresh(dataset)}
                    >
                      <ArrowClockwise size={15} /> Обновить датасет
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      disabled={refreshing?.busy || !!refreshing?.run}
                      onSelect={() => setDialog({ action: "rename", dataset })}
                    >
                      <Pencil size={15} /> Переименовать
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      disabled={refreshing?.busy || !!refreshing?.run}
                      onSelect={() => setDialog({ action: "delete", dataset })}
                    >
                      <Trash size={15} /> Удалить
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
            <DatasetRefreshStatus id={dataset.id} />
            {open && (
              <div className="columns-tree">
                {dataset.columns.map((column) => (
                  <div
                    key={column.id}
                    className="source-column"
                    title={`${column.sourceName} · ${column.duckdbType}`}
                  >
                    <span>
                      <SearchHighlight text={column.name} query={filter} />
                    </span>
                    <small>{column.duckdbType}</small>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {dialog?.action === "rename" && (
        <DatasetNameDialog
          title="Переименовать датасет"
          initialName={dialog.dataset.name}
          onClose={close}
          onConfirm={async (name) => {
            const { id, revision } = dialog.dataset;
            if (name === dialog.dataset.name) return;
            await api<Dataset>(datasetPath(id), {
              method: "PATCH",
              body: json({
                name,
                baseRevision: revision,
                mutationId: crypto.randomUUID(),
              }),
            });
            await catalog.reload();
          }}
        />
      )}
      {dialog?.action === "delete" && (
        <Modal
          open
          title="Удалить датасет?"
          description={`Имя «${dialog.dataset.name}» станет недоступно в новых SQL-запросах. Текущие снимки на досках сохранятся.`}
          dismissible={!deleting}
          onOpenChange={(open) => {
            if (!open) close();
          }}
        >
          {error && <ErrorBox error={error} />}
          <div className="modal-actions">
            <button
              type="button"
              className="button"
              onClick={close}
              disabled={deleting}
            >
              Отмена
            </button>
            <button
              type="button"
              className="button danger"
              onClick={() => void remove(dialog.dataset)}
              disabled={deleting}
            >
              {deleting ? "Удаление…" : "Удалить"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
