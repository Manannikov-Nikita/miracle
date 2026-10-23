import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowSquareOut,
  CheckCircle,
  Database,
  PencilSimple,
  Plus,
  Trash,
  PlugsConnected,
  ShieldCheck,
} from "@phosphor-icons/react";
import type { Connection, ConnectionInput, User } from "../../shared/types";
import { api, json } from "../api";
import { isLocalInstallation } from "../local-installation";
import { EmptyState, ErrorBox, IconButton, Modal, Spinner } from "./UI";
import ClickHouseConnectionOptions, {
  clickhouseFormError,
} from "./ClickHouseConnectionOptions";
const blank: ConnectionInput = {
  name: "",
  engine: "clickhouse",
  url: "http://localhost:8123",
  username: "",
  password: "",
  database: "",
};
export default function Connections({
  open,
  onClose,
  user,
  connections,
  onChanged,
  onNotify,
}: {
  open: boolean;
  onClose: () => void;
  user: User;
  connections: Connection[];
  onChanged: () => void;
  onNotify: (m: string, t?: "error" | "success" | "info") => void;
}) {
  const [editing, setEditing] = useState<Connection | null | undefined>();
  const [form, setForm] = useState<ConnectionInput>(blank);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState<Record<string, string>>({});
  const [deleteId, setDeleteId] = useState("");
  const [readingCertificate, setReadingCertificate] = useState(false);
  const [draftTesting, setDraftTesting] = useState(false);
  const [draftStatus, setDraftStatus] = useState<{
    form: ConnectionInput;
    message: string;
    ok: boolean;
  }>();
  useEffect(() => {
    if (!open) {
      setEditing(undefined);
      setError("");
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
          }
        : { ...blank },
    );
    setError("");
    setDraftStatus(undefined);
    setReadingCertificate(false);
  }
  function validate() {
    return form.engine === "clickhouse"
      ? clickhouseFormError(form.url, form.clickhouse, editing?.clickhouse)
      : "";
  }
  async function testDraft() {
    const validation = validate();
    if (validation) {
      setDraftStatus({ form, message: validation, ok: false });
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
      setDraftStatus({ form, message: (error as Error).message, ok: false });
    } finally {
      setDraftTesting(false);
    }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    const validation = validate();
    if (validation) {
      setError(validation);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const body = { ...form, password: form.password || undefined };
      await api(`/api/connections${editing ? "/" + editing.id : ""}`, {
        method: editing ? "PATCH" : "POST",
        body: json(body),
      });
      setEditing(undefined);
      onChanged();
      onNotify("Подключение сохранено", "success");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function test(c: Connection) {
    setTesting(c.id);
    try {
      const r = await api<{ ok: true; version?: string }>(
        `/api/connections/${c.id}/test`,
        { method: "POST" },
      );
      setStatus((s) => ({
        ...s,
        [c.id]: `Доступно${r.version ? " · " + r.version : ""}`,
      }));
    } catch (e) {
      setStatus((s) => ({ ...s, [c.id]: (e as Error).message }));
    } finally {
      setTesting("");
    }
  }
  async function remove() {
    setBusy(true);
    try {
      await api(`/api/connections/${deleteId}`, { method: "DELETE" });
      setDeleteId("");
      onChanged();
      onNotify(
        "Подключение удалено. Сохранённые снимки остаются на досках.",
        "success",
      );
    } catch (e) {
      onNotify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Modal
        open={open}
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
        description="Общие источники данных вашей команды"
        wide
      >
        {editing !== undefined ? (
          <form onSubmit={save} className="connection-form">
            <div className="engine-picker">
              {(["clickhouse", "trino"] as const).map((engine) => (
                <button
                  type="button"
                  key={engine}
                  className={`engine-option ${form.engine === engine ? "selected" : ""}`}
                  onClick={() => {
                    if (!editing && engine !== form.engine)
                      setForm((f) => ({
                        ...f,
                        engine,
                        clickhouse: undefined,
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
                placeholder="https://clickhouse.company.ru:8443"
              />
              <small className="muted">
                Адрес должен быть доступен серверу Miracle. Для внешних
                подключений используйте HTTPS.
              </small>
              {isLocalInstallation() && (
                <small className="muted">
                  Если {form.engine === "clickhouse" ? "ClickHouse" : "Trino"}{" "}
                  работает на этом компьютере, из Docker используйте{" "}
                  <code>
                    http://host.docker.internal:
                    {form.engine === "clickhouse" ? "8123" : "8080"}
                  </code>
                  . Адрес localhost внутри контейнера указывает на сам контейнер
                  Miracle.
                </small>
              )}
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
            {form.engine === "clickhouse" && (
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
            )}
            <div className="info-box">
              <ShieldCheck size={18} />
              <span>
                Используйте пользователя БД с правами только на чтение. Данные
                подключения доступны только серверу.
              </span>
            </div>
            {error && <ErrorBox>{error}</ErrorBox>}
            {draftStatus?.form === form && (
              <div
                role="status"
                className={
                  draftStatus.ok
                    ? "success-text connection-test-status"
                    : "error-box"
                }
              >
                {draftStatus.message}
              </div>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="button"
                onClick={() => setEditing(undefined)}
              >
                Назад
              </button>
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
                {busy ? <Spinner /> : "Сохранить подключение"}
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="connection-list">
              {connections.map((c) => (
                <div className="connection-item" key={c.id}>
                  <span className={`engine-logo ${c.engine}`}>
                    {c.engine === "clickhouse" ? "▥" : "T"}
                  </span>
                  <div className="connection-detail">
                    <strong>{c.name}</strong>
                    <span>
                      {c.engine === "clickhouse" ? "ClickHouse" : "Trino"} ·{" "}
                      {c.url}
                    </span>
                    {status[c.id] && (
                      <small
                        className={
                          status[c.id].startsWith("Доступно")
                            ? "success-text"
                            : "error-text"
                        }
                        role="status"
                      >
                        {status[c.id]}
                      </small>
                    )}
                  </div>
                  <button
                    className="button small"
                    disabled={Boolean(testing)}
                    onClick={() => test(c)}
                  >
                    {testing === c.id ? (
                      <Spinner />
                    ) : (
                      <PlugsConnected size={15} />
                    )}
                    Проверить
                  </button>
                  {user.role === "admin" && (
                    <>
                      <IconButton
                        label={`Настроить ${c.name}`}
                        onClick={() => edit(c)}
                      >
                        <PencilSimple size={16} />
                      </IconButton>
                      <IconButton
                        label={`Удалить ${c.name}`}
                        onClick={() => setDeleteId(c.id)}
                      >
                        <Trash size={16} />
                      </IconButton>
                    </>
                  )}
                </div>
              ))}
              {!connections.length && (
                <EmptyState
                  icon={<Database size={30} />}
                  title="Подключите первый источник"
                  description="Добавьте ClickHouse или Trino, чтобы исследовать данные в SQL-редакторе."
                  action={
                    user.role === "admin" ? (
                      <button className="button primary" onClick={() => edit()}>
                        <Plus size={16} />
                        Добавить подключение
                      </button>
                    ) : undefined
                  }
                />
              )}
            </div>
            <div className="modal-actions">
              <span className="muted">{connections.length} подключений</span>
              {user.role === "admin" && connections.length > 0 && (
                <button className="button primary" onClick={() => edit()}>
                  <Plus size={16} />
                  Новое подключение
                </button>
              )}
            </div>
          </>
        )}
      </Modal>
      <Modal
        open={!!deleteId}
        onOpenChange={(o) => {
          if (!o) setDeleteId("");
        }}
        title="Удалить подключение?"
        description="Сохранённые результаты останутся. Обновить связанные блоки будет нельзя до перепривязки к другому источнику."
      >
        <div className="modal-actions">
          <button className="button" onClick={() => setDeleteId("")}>
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
