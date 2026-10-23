import { useEffect, useState, type FormEvent } from "react";
import {
  Check,
  Copy,
  Key,
  Plus,
  ShieldCheck,
  UserMinus,
  UserPlus,
  Users,
} from "@phosphor-icons/react";
import type { Role, User } from "../../shared/types";
import { api, json } from "../api";
import { isLocalInstallation } from "../local-installation";
import { ErrorBox, IconButton, Modal, Spinner } from "./UI";
import { Select } from "./Select";
const roles: Record<Role, string> = {
  admin: "Администратор",
  editor: "Редактор",
  viewer: "Наблюдатель",
};
const roleOptions = Object.entries(roles).map(([value, label]) => ({
  value,
  label,
}));
export default function Team({
  open,
  onClose,
  currentUser,
  onNotify,
}: {
  open: boolean;
  onClose: () => void;
  currentUser: User;
  onNotify: (m: string, t?: "error" | "success" | "info") => void;
}) {
  const [users, setUsers] = useState<User[]>([]);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [invite, setInvite] = useState(false);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    try {
      setUsers(await api<User[]>("/api/users"));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    if (open) void load();
    else {
      setInvite(false);
      setLink("");
      setError("");
    }
  }, [open]);
  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ user: User; activationUrl: string }>("/api/users", {
        method: "POST",
        body: json({ email, name, role }),
      });
      setLink(new URL(r.activationUrl, location.origin).href);
      setInvite(false);
      setEmail("");
      setName("");
      void load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function update(user: User, values: Partial<User>) {
    setBusy(true);
    try {
      await api(`/api/users/${user.id}`, {
        method: "PATCH",
        body: json(values),
      });
      void load();
    } catch (e) {
      onNotify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  async function reset(user: User) {
    setBusy(true);
    try {
      const r = await api<{ url: string }>(`/api/users/${user.id}/reset`, {
        method: "POST",
      });
      setLink(new URL(r.url, location.origin).href);
    } catch (e) {
      onNotify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Ваша команда"
      description="Одна рабочая область, общий контекст"
      wide
    >
      {error && <ErrorBox>{error}</ErrorBox>}
      {link && (
        <div className="activation-link">
          <strong>Одноразовая ссылка готова</strong>
          <p>
            Передайте её участнику самостоятельно. Miracle не отправляет письма.
          </p>
          {isLocalInstallation() &&
            isLocalInstallation(new URL(link).hostname) && (
              <p>
                Это локальная ссылка: на другом компьютере она не откроется. Для
                совместной работы нужен доступный команде адрес Miracle.
              </p>
            )}
          <div>
            <input
              aria-label="Ссылка активации или сброса"
              readOnly
              value={link}
            />
            <IconButton
              label="Скопировать ссылку"
              onClick={() =>
                navigator.clipboard
                  .writeText(link)
                  .then(() => onNotify("Ссылка скопирована", "success"))
                  .catch(() =>
                    onNotify("Выделите и скопируйте ссылку вручную", "info"),
                  )
              }
            >
              <Copy size={17} />
            </IconButton>
          </div>
        </div>
      )}
      {invite ? (
        <form onSubmit={create} className="team-invite">
          <div className="form-row">
            <label>
              Имя
              <input
                required
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Анна Смирнова"
              />
            </label>
            <label>
              Email
              <input
                required
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="anna@company.ru"
              />
            </label>
          </div>
          <label>
            Роль
            <Select
              aria-label="Роль"
              value={role}
              onValueChange={(value) => setRole(value as Role)}
              options={roleOptions}
            />
          </label>
          <div className="modal-actions">
            <button
              type="button"
              className="button"
              onClick={() => setInvite(false)}
            >
              Отмена
            </button>
            <button className="button primary" disabled={busy}>
              {busy ? (
                <Spinner />
              ) : (
                <>
                  <UserPlus size={16} />
                  Создать приглашение
                </>
              )}
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="team-list">
            {users.map((u) => (
              <div
                className={`team-member ${u.disabled ? "disabled" : ""}`}
                key={u.id}
              >
                <div className="avatar">
                  {(u.name || u.email).slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <strong>
                    {u.name || u.email}
                    {u.id === currentUser.id && (
                      <span className="you-label">Вы</span>
                    )}
                  </strong>
                  <span>
                    {u.email}
                    {u.disabled ? " · Доступ отключён" : ""}
                  </span>
                </div>
                <Select
                  aria-label={`Роль ${u.email}`}
                  value={u.role}
                  disabled={busy || u.id === currentUser.id}
                  onValueChange={(value) => update(u, { role: value as Role })}
                  options={roleOptions}
                />
                <IconButton
                  label={`Сбросить пароль ${u.email}`}
                  disabled={busy}
                  onClick={() => reset(u)}
                >
                  <Key size={16} />
                </IconButton>
                <IconButton
                  label={`${u.disabled ? "Включить" : "Отключить"} доступ ${u.email}`}
                  disabled={busy || u.id === currentUser.id}
                  onClick={() => update(u, { disabled: !u.disabled })}
                >
                  {u.disabled ? (
                    <UserPlus size={16} />
                  ) : (
                    <UserMinus size={16} />
                  )}
                </IconButton>
              </div>
            ))}
          </div>
          <div className="info-box">
            <ShieldCheck size={18} />
            <span>
              Наблюдатели читают доски. Редакторы выполняют SQL и работают с
              досками. Администраторы управляют доступом и источниками.
            </span>
          </div>
          <div className="modal-actions">
            <span className="muted">{users.length} участников</span>
            <button
              className="button primary"
              onClick={() => {
                setInvite(true);
                setLink("");
              }}
            >
              <Plus size={16} />
              Добавить участника
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
