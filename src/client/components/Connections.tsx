import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  CheckCircle,
  Database,
  PencilSimple,
  Plus,
  Trash,
  PlugsConnected,
  ShieldCheck,
} from "@phosphor-icons/react";
import type { Connection, ConnectionInput } from "../../shared/types";
import { api, json } from "../api";
import { describeError } from "../error-message";
import { EmptyState, ErrorBox, IconButton, Modal, Spinner } from "./UI";
import ClickHouseConnectionOptions, {
  clickhouseFormError,
} from "./ClickHouseConnectionOptions";
import TrinoConnectionOptions, {
  trinoFormError,
} from "./TrinoConnectionOptions";
const blank: ConnectionInput = {
  name: "",
  engine: "clickhouse",
  url: "http://localhost:8123",
  username: "",
  password: "",
  database: "",
};
type TestStatus = { ok: true; message: string } | { ok: false; error: unknown };
function operationErrorTitle(error: unknown, fallback: string) {
  return describeError(error, { context: "connection" }).title ===
    "Не удалось проверить подключение."
    ? fallback
    : undefined;
}
export default function Connections({
  open,
  onClose,
  connections,
  onChanged,
  onNotify,
}: {
  open: boolean;
  onClose: () => void;
  connections: Connection[];
  onChanged: (id?: string) => void;
  onNotify: (m: string, t?: "error" | "success" | "info") => void;
}) {
  const [editing, setEditing] = useState<Connection | null | undefined>();
  const [form, setForm] = useState<ConnectionInput>(blank);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState("");
  const [saveError, setSaveError] = useState<{
    form: ConnectionInput;
    error: unknown;
  }>();
  const [status, setStatus] = useState<Record<string, TestStatus | undefined>>(
    {},
  );
  const [deleteId, setDeleteId] = useState("");
  const [deleteError, setDeleteError] = useState<unknown>();
  const [readingCertificate, setReadingCertificate] = useState(false);
  const [draftTesting, setDraftTesting] = useState(false);
  const [draftStatus, setDraftStatus] = useState<
    TestStatus & { form: ConnectionInput }
  >();
  useEffect(() => {
    if (!open) {
      setEditing(undefined);
      setSaveError(undefined);
    }
  }, [open]);
  function edit(c?: Connection) {
    setEditing(c ?? null);
    setForm(
      c
        ? {
            name: c.name,
            engine: c.engine,
            url: c.url,
            username: c.username,
            database: c.database || "",
            catalog: c.catalog || "",
            schema: c.schema || "",
            clickhouse: c.clickhouse
              ? {
                  requestTimeoutMs: c.clickhouse.requestTimeoutMs,
                  compression: c.clickhouse.compression,
                  tls: c.clickhouse.tls
                    ? { certificateAuth: c.clickhouse.tls.certificateAuth }
                    : undefined,
                  settings: c.clickhouse.settings
                    ? { ...c.clickhouse.settings }
                    : undefined,
                }
              : undefined,
            trino: c.trino ? {} : undefined,
          }
        : { ...blank },
    );
    setSaveError(undefined);
    setDraftStatus(undefined);
    setReadingCertificate(false);
  }
  function validate() {
    return form.engine === "clickhouse"
      ? clickhouseFormError(form.url, form.clickhouse, editing?.clickhouse)
      : trinoFormError(form.url, form.trino, editing?.trino);
  }
  async function testDraft() {
    setSaveError(undefined);
    const validation = validate();
    if (validation) {
      setDraftStatus({ form, error: validation, ok: false });
      return;
    }
    setDraftTesting(true);
    setDraftStatus(undefined);
    try {
      const result = await api<{ ok: true; version?: string }>(
        "/api/connections/test",
        {
          method: "POST",
          body: json({
            ...form,
            password: form.password || undefined,
            id: editing?.id,
          }),
        },
      );
      setDraftStatus({
        form,
        message: `Доступно${result.version ? " · " + result.version : ""}`,
        ok: true,
      });
    } catch (error) {
      setDraftStatus({ form, error, ok: false });
    } finally {
      setDraftTesting(false);
    }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    setDraftStatus(undefined);
    const validation = validate();
    if (validation) {
      setSaveError({ form, error: validation });
      return;
    }
    setBusy(true);
    setSaveError(undefined);
    try {
      const body = { ...form, password: form.password || undefined };
      await api(`/api/connections${editing ? "/" + editing.id : ""}`, {
        method: editing ? "PATCH" : "POST",
        body: json(body),
      });
      if (editing)
        setStatus((current) => ({ ...current, [editing.id]: undefined }));
      setEditing(undefined);
      onChanged(editing?.id);
      onNotify("Подключение сохранено", "success");
    } catch (e) {
      setSaveError({ form, error: e });
    } finally {
      setBusy(false);
    }
  }
  async function test(c: Connection) {
    setTesting(c.id);
    setStatus((s) => ({ ...s, [c.id]: undefined }));
    try {
      const r = await api<{ ok: true; version?: string }>(
        `/api/connections/${c.id}/test`,
        { method: "POST" },
      );
      setStatus((s) => ({
        ...s,
        [c.id]: {
          ok: true,
          message: `Доступно${r.version ? " · " + r.version : ""}`,
        },
      }));
    } catch (e) {
      setStatus((s) => ({ ...s, [c.id]: { ok: false, error: e } }));
    } finally {
      setTesting("");
    }
  }
  async function remove() {
    setBusy(true);
    setDeleteError(undefined);
    try {
      await api(`/api/connections/${deleteId}`, { method: "DELETE" });
      setDeleteId("");
      onChanged(deleteId);
      onNotify(
        "Подключение удалено. Сохранённые снимки остаются на досках.",
        "success",
      );
    } catch (e) {
      setDeleteError(e);
    } finally {
      setBusy(false);
    }
  }
  const formPending = busy || draftTesting;
  return (
    <>
      <Modal
        open={open}
        dismissible={!formPending}
        onOpenChange={(o) => {
          if (!o) onClose();
        }}
        title={
          editing !== undefined
            ? editing
              ? "Настройки подключения"
              : "Новое подключение"
            : "Подключения"
        }
        description="Источники данных вашей рабочей области"
        wide
      >
        {editing !== undefined ? (
          <form
            onSubmit={save}
            className="connection-form"
            aria-busy={formPending}
          >
            <fieldset
              className="connection-form-fields"
              aria-label="Параметры подключения"
              disabled={formPending || readingCertificate}
            >
              {editing ? (
                <div className="connection-engine">
                  <span
                    className={`engine-logo ${form.engine}`}
                    aria-hidden="true"
                  >
                    {form.engine === "clickhouse" ? "▥" : "T"}
                  </span>
                  <span>
                    {form.engine === "clickhouse" ? "ClickHouse" : "Trino"}
                  </span>
                </div>
              ) : (
                <div
                  className="engine-picker"
                  role="group"
                  aria-label="Движок базы данных"
                >
                  {(["clickhouse", "trino"] as const).map((engine) => (
                    <button
                      type="button"
                      key={engine}
                      aria-pressed={form.engine === engine}
                      className={`engine-option ${form.engine === engine ? "selected" : ""}`}
                      onClick={() => {
                        if (!editing && engine !== form.engine)
                          setForm((f) => ({
                            ...f,
                            engine,
                            clickhouse: undefined,
                            trino: undefined,
                            url:
                              engine === "clickhouse"
                                ? "http://localhost:8123"
                                : "http://localhost:8080",
                          }));
                      }}
                      disabled={
                        !!editing || busy || draftTesting || readingCertificate
                      }
                    >
                      <span className={`engine-logo ${engine}`}>
                        {engine === "clickhouse" ? "▥" : "T"}
                      </span>
                      <span>
                        {engine === "clickhouse" ? "ClickHouse" : "Trino"}
                      </span>
                      {form.engine === engine && <CheckCircle size={16} />}
                    </button>
                  ))}
                </div>
              )}
              <label>
                Название
                <input
                  autoFocus
                  required
                  maxLength={120}
                  value={form.name}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, name: e.target.value }))
                  }
                  placeholder="Например, Analytics · production"
                />
              </label>
              <label>
                HTTP-адрес сервера
                <input
                  required
                  type="url"
                  value={form.url}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, url: e.target.value }))
                  }
                  placeholder={
                    form.engine === "clickhouse"
                      ? "https://clickhouse.company.ru:8443"
                      : "https://trino.company.ru"
                  }
                />
                <small className="muted">
                  Адрес должен быть доступен серверу Miracle. Для внешних
                  подключений используйте HTTPS.
                </small>
                <small className="muted">
                  Если {form.engine === "clickhouse" ? "ClickHouse" : "Trino"}{" "}
                  работает на этом компьютере, используйте{" "}
                  <code>
                    http://127.0.0.1:
                    {form.engine === "clickhouse" ? "8123" : "8080"}
                  </code>
                  .
                </small>
              </label>
              <div className="form-row">
                <label>
                  Пользователь
                  <input
                    required
                    autoComplete="off"
                    value={form.username}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, username: e.target.value }))
                    }
                    placeholder="readonly"
                  />
                </label>
                <label>
                  Пароль
                  <input
                    type="password"
                    disabled={
                      form.engine === "clickhouse" &&
                      Boolean(form.clickhouse?.tls?.certificateAuth)
                    }
                    autoComplete="new-password"
                    value={form.password || ""}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, password: e.target.value }))
                    }
                    placeholder={
                      editing?.hasPassword
                        ? "Сохранён · оставьте пустым"
                        : "Пароль подключения"
                    }
                  />
                </label>
              </div>
              {form.engine === "clickhouse" ? (
                <label>
                  База данных
                  <input
                    value={form.database || ""}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, database: e.target.value }))
                    }
                    placeholder="default"
                  />
                </label>
              ) : (
                <div className="form-row">
                  <label>
                    Каталог
                    <input
                      value={form.catalog || ""}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, catalog: e.target.value }))
                      }
                      placeholder="tpch"
                    />
                  </label>
                  <label>
                    Схема
                    <input
                      value={form.schema || ""}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, schema: e.target.value }))
                      }
                      placeholder="tiny"
                    />
                  </label>
                </div>
              )}
              {form.engine === "clickhouse" ? (
                <ClickHouseConnectionOptions
                  key={editing?.id ?? "new"}
                  url={form.url}
                  options={form.clickhouse}
                  saved={editing?.clickhouse}
                  disabled={busy || draftTesting}
                  onPendingChange={setReadingCertificate}
                  onUrlChange={(url) =>
                    setForm((current) => ({ ...current, url }))
                  }
                  onChange={(clickhouse) =>
                    setForm((current) => ({ ...current, clickhouse }))
                  }
                />
              ) : (
                <TrinoConnectionOptions
                  key={editing?.id ?? "new"}
                  url={form.url}
                  options={form.trino}
                  saved={editing?.trino}
                  disabled={busy || draftTesting}
                  onPendingChange={setReadingCertificate}
                  onUrlChange={(url) =>
                    setForm((current) => ({ ...current, url }))
                  }
                  onChange={(trino) =>
                    setForm((current) => ({ ...current, trino }))
                  }
                />
              )}
              <div className="info-box">
                <ShieldCheck size={18} />
                <span>
                  Используйте пользователя БД с правами только на чтение. Данные
                  подключения доступны только серверу.
                </span>
              </div>
            </fieldset>
            <div className="connection-form-footer">
              {saveError?.form === form && (
                <ErrorBox
                  error={saveError.error}
                  context="connection"
                  engine={form.engine}
                  title={operationErrorTitle(
                    saveError.error,
                    "Не удалось сохранить подключение.",
                  )}
                />
              )}
              {draftStatus?.form === form &&
                (draftStatus.ok ? (
                  <div
                    role="status"
                    className="success-text connection-test-status"
                  >
                    {draftStatus.message}
                  </div>
                ) : (
                  <ErrorBox
                    error={draftStatus.error}
                    context="connection"
                    engine={form.engine}
                  />
                ))}
              <div className="modal-actions connection-form-actions">
                <button
                  type="button"
                  className="button"
                  title="К списку подключений"
                  disabled={formPending}
                  onClick={() => setEditing(undefined)}
                >
                  <ArrowLeft size={16} aria-hidden="true" />
                  Назад
                </button>
                <div className="connection-submit-actions">
                  <button
                    type="button"
                    className="button"
                    disabled={busy || draftTesting || readingCertificate}
                    onClick={(event) => {
                      if (event.currentTarget.form?.reportValidity())
                        void testDraft();
                    }}
                  >
                    {draftTesting ? <Spinner /> : <PlugsConnected size={15} />}{" "}
                    Проверить
                  </button>
                  <button
                    className="button primary"
                    disabled={busy || draftTesting || readingCertificate}
                  >
                    {busy && <Spinner />}
                    Сохранить
                  </button>
                </div>
              </div>
            </div>
          </form>
        ) : (
          <>
            <div className="connection-list">
              {connections.map((c) => {
                const testStatus = status[c.id];
                return (
                  <div className="connection-item" key={c.id}>
                    <span className={`engine-logo ${c.engine}`}>
                      {c.engine === "clickhouse" ? "▥" : "T"}
                    </span>
                    <div className="connection-detail">
                      <strong title={c.name}>{c.name}</strong>
                      <span title={c.url}>
                        {c.engine === "clickhouse" ? "ClickHouse" : "Trino"} ·{" "}
                        {c.url}
                      </span>
                      {testStatus &&
                        (testStatus.ok ? (
                          <small className="success-text" role="status">
                            {testStatus.message}
                          </small>
                        ) : (
                          <ErrorBox
                            error={testStatus.error}
                            context="connection"
                            engine={c.engine}
                          />
                        ))}
                    </div>
                    <div className="connection-item-actions">
                      <IconButton
                        label={`Проверить ${c.name}`}
                        disabled={Boolean(testing)}
                        onClick={() => test(c)}
                      >
                        {testing === c.id ? (
                          <Spinner />
                        ) : (
                          <PlugsConnected size={16} />
                        )}
                      </IconButton>
                      <IconButton
                        label={`Настроить ${c.name}`}
                        onClick={() => edit(c)}
                      >
                        <PencilSimple size={16} />
                      </IconButton>
                      <IconButton
                        label={`Удалить ${c.name}`}
                        onClick={() => {
                          setDeleteError(undefined);
                          setDeleteId(c.id);
                        }}
                      >
                        <Trash size={16} />
                      </IconButton>
                    </div>
                  </div>
                );
              })}
              {!connections.length && (
                <EmptyState
                  icon={<Database size={30} />}
                  title="Подключите первый источник"
                  description="Добавьте ClickHouse или Trino, чтобы исследовать данные в SQL-редакторе."
                  action={
                    <button className="button primary" onClick={() => edit()}>
                      <Plus size={16} />
                      Добавить подключение
                    </button>
                  }
                />
              )}
            </div>
            {connections.length > 0 && (
              <div className="modal-actions">
                <button className="button primary" onClick={() => edit()}>
                  <Plus size={16} />
                  Новое подключение
                </button>
              </div>
            )}
          </>
        )}
      </Modal>
      <Modal
        open={!!deleteId}
        dismissible={!busy}
        onOpenChange={(o) => {
          if (!o) setDeleteId("");
        }}
        title="Удалить подключение?"
        description="Сохранённые результаты останутся. Обновить связанные блоки будет нельзя до перепривязки к другому источнику."
      >
        {deleteError !== undefined && (
          <ErrorBox
            error={deleteError}
            context="connection"
            engine={connections.find((c) => c.id === deleteId)?.engine}
            title={operationErrorTitle(
              deleteError,
              "Не удалось удалить подключение.",
            )}
          />
        )}
        <div className="modal-actions">
          <button
            className="button"
            onClick={() => setDeleteId("")}
            disabled={busy}
          >
            Отмена
          </button>
          <button className="button danger" onClick={remove} disabled={busy}>
            Удалить
          </button>
        </div>
      </Modal>
    </>
  );
}
