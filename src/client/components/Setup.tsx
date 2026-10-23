import { useState, type FormEvent } from "react";
import { ArrowRight, Database, ShieldCheck } from "@phosphor-icons/react";
import type { User } from "../../shared/types";
import { api, ApiRequestError, json, setCsrfToken } from "../api";
import { Brand, ErrorBox, Spinner } from "./UI";

export default function Setup({
  token,
  onComplete,
  onInitialized,
}: {
  token: string | null;
  onComplete: (user: User) => void;
  onInitialized: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [invalidLink, setInvalidLink] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token || busy || invalidLink) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ user: User; csrfToken: string }>(
        "/api/setup/complete",
        { method: "POST", body: json({ token, name, email, password }) },
      );
      setCsrfToken(result.csrfToken);
      setPassword("");
      onComplete(result.user);
    } catch (cause) {
      // Another browser may have completed setup while this form was open.
      try {
        const status = await api<{ required: boolean }>("/api/setup/status");
        if (!status.required) {
          onInitialized();
          return;
        }
      } catch {
        // Keep the form and original error when the status request is offline.
      }
      if (
        cause instanceof ApiRequestError &&
        ([401, 403, 410].includes(cause.status) ||
          cause.code === "SETUP_TOKEN_INVALID")
      ) {
        setInvalidLink(true);
        setPassword("");
        setError(
          "Ссылка истекла или уже использована. Получите новую ссылку запуска.",
        );
      } else {
        setError((cause as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }
  const needsLink = !token || invalidLink;
  return (
    <main className="auth-page">
      <header className="auth-header">
        <Brand />
        <span className="eyebrow">ПЕРВЫЙ ЗАПУСК</span>
      </header>
      <div className="auth-layout">
        <section className="auth-story">
          <div className="story-kicker">
            <span className="status-dot" /> Ваша инфраструктура. Ваши данные.
          </div>
          <h1>
            Место для
            <br />
            <span>ваших вопросов.</span>
          </h1>
          <p className="story-description">
            Создайте рабочую область, подключите ClickHouse или Trino
            <br />и исследуйте свои данные в SQL-редакторе и на доске.
          </p>
          <div className="auth-features">
            <span>
              <ShieldCheck size={17} /> Вы — администратор
            </span>
            <span>
              <Database size={17} /> Ваши источники данных
            </span>
          </div>
        </section>
        <section className="auth-card" aria-labelledby="setup-heading">
          <span className="eyebrow">ВАША РАБОЧАЯ ОБЛАСТЬ</span>
          <h2 id="setup-heading">
            {needsLink ? "Нужна ссылка запуска" : "Начнём с вас"}
          </h2>
          <p className="muted">
            {needsLink ? (
              <>
                Из папки Miracle снова запустите <code>start.cmd</code> в Windows
                или <code>sh start.sh</code> в macOS/Linux и откройте выданную ссылку. Она действует 30 минут и только один раз.
              </>
            ) : (
              "Создайте учётную запись администратора. Затем добавьте свой первый источник данных."
            )}
          </p>
          {error && needsLink && <ErrorBox>{error}</ErrorBox>}
          {!needsLink && (
            <form onSubmit={submit} aria-busy={busy}>
              <label>
                Ваше имя
                <input
                  autoComplete="name"
                  autoFocus
                  required
                  maxLength={200}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Как к вам обращаться"
                />
              </label>
              <label>
                Email
                <input
                  type="email"
                  autoComplete="username"
                  required
                  maxLength={320}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="name@company.ru"
                />
              </label>
              <label>
                Пароль
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={256}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Не менее 12 символов"
                />
              </label>
              {error && <ErrorBox>{error}</ErrorBox>}
              <button className="button primary auth-submit" disabled={busy}>
                {busy ? (
                  <>
                    <Spinner /> Создаём рабочую область…
                  </>
                ) : (
                  <>
                    Создать рабочую область
                    <ArrowRight size={17} />
                  </>
                )}
              </button>
            </form>
          )}
          <div className="auth-help">
            {needsLink
              ? "Используйте ссылку из терминала на этом компьютере."
              : "Сохраните пароль: он понадобится для следующего входа. Рабочая область начнётся с пустой доски и SQL-файла."}
          </div>
        </section>
      </div>
      <footer className="auth-footer">
        <span>Miracle · Пространство для хороших вопросов</span>
        <span>Ваша инфраструктура. Ваши данные.</span>
      </footer>
    </main>
  );
}
