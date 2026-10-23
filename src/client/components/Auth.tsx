import { useState, type FormEvent } from "react";
import {
  ArrowRight,
  Code,
  Graph,
  Table,
  ArrowUpRight,
} from "@phosphor-icons/react";
import type { User } from "../../shared/types";
import { api, json, setCsrfToken } from "../api";
import { Brand, ErrorBox, Spinner } from "./UI";
export default function Auth({ onLogin }: { onLogin: (user: User) => void }) {
  const token = new URLSearchParams(location.search).get("token");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [activated, setActivated] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (token && !activated) {
        const data = await api<{ user?: User; csrfToken?: string }>(
          "/api/auth/activate",
          {
            method: "POST",
            body: json({ token, password, name: name || undefined }),
          },
        );
        if (data?.user && data.csrfToken) {
          setCsrfToken(data.csrfToken);
          history.replaceState({}, "", location.pathname);
          onLogin(data.user);
        } else {
          setActivated(true);
          setPassword("");
          history.replaceState({}, "", location.pathname);
        }
      } else {
        const data = await api<{ user: User; csrfToken: string }>(
          "/api/auth/login",
          { method: "POST", body: json({ email, password }) },
        );
        setCsrfToken(data.csrfToken);
        onLogin(data.user);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const activation = Boolean(token && !activated);
  return (
    <main className="auth-page">
      <div className="auth-header">
        <Brand />
        <span className="eyebrow">АНАЛИТИКА В ОБЩЕМ КОНТЕКСТЕ</span>
      </div>
      <div className="auth-layout">
        <section className="auth-story">
          <div className="story-kicker">
            <span className="status-dot" /> Рабочая среда для вашей команды
          </div>
          <h1>
            От запроса
            <br />к <span>ясной картине.</span>
          </h1>
          <p className="story-description">
            SQL, данные и мысли — рядом.
            <br />
            Исследуйте в редакторе. Собирайте выводы на доске.
          </p>
          <div className="auth-diagram" aria-hidden="true">
            <div className="diagram-code">
              <div className="diagram-window">
                <Code size={14} />
                <span>revenue.sql</span>
                <span className="diagram-dot" />
              </div>
              <code>
                <span>SELECT</span> month, sum(revenue)
                <br />
                <span>FROM</span> analytics.sales
                <br />
                <span>GROUP BY</span> month;
              </code>
            </div>
            <div className="diagram-line">
              <ArrowRight size={18} />
            </div>
            <div className="diagram-chart">
              <div>
                <Graph size={15} />
                <span>Динамика выручки</span>
                <ArrowUpRight size={13} />
              </div>
              <div className="diagram-bars">
                {[35, 49, 42, 65, 58, 80, 72, 95].map((h, i) => (
                  <i key={i} style={{ height: `${h}%` }} />
                ))}
              </div>
              <span className="diagram-caption">
                ЗАПРОС → РЕЗУЛЬТАТ → ИСТОРИЯ
              </span>
            </div>
          </div>
          <div className="auth-features">
            <span>
              <Code size={17} /> ClickHouse & Trino
            </span>
            <span>
              <Table size={17} /> Живые запросы
            </span>
            <span>
              <Graph size={17} /> Общие доски
            </span>
          </div>
        </section>
        <section className="auth-card">
          <span className="eyebrow">ВАША РАБОЧАЯ ОБЛАСТЬ</span>
          <h2>
            {activation
              ? "Добро пожаловать"
              : activated
                ? "Пароль установлен"
                : "Продолжим исследование"}
          </h2>
          <p className="muted">
            {activation
              ? "Задайте пароль для входа в команду."
              : activated
                ? "Теперь войдите с вашим email и новым паролем."
                : "Войдите, чтобы открыть запросы и доски команды."}
          </p>
          <form onSubmit={submit}>
            {activation ? (
              <label>
                Ваше имя
                <input
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Как к вам обращаться"
                />
              </label>
            ) : (
              <label>
                Email
                <input
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@company.ru"
                />
              </label>
            )}
            <label>
              Пароль
              <input
                type="password"
                autoComplete={activation ? "new-password" : "current-password"}
                minLength={activation ? 12 : undefined}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  activation ? "Не менее 12 символов" : "Введите пароль"
                }
              />
            </label>
            {error && <ErrorBox>{error}</ErrorBox>}
            <button className="button primary auth-submit" disabled={busy}>
              {busy ? (
                <Spinner />
              ) : (
                <>
                  {activation ? "Создать пароль" : "Войти в рабочую область"}
                  <ArrowRight size={17} />
                </>
              )}
            </button>
          </form>
          <div className="auth-help">
            {activation
              ? "Ссылка действует один раз."
              : "Нет доступа или забыли пароль? Обратитесь к администратору вашей команды."}
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
