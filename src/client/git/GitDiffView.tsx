import { useEffect, useState } from "react";
import type { GitDiff } from "../../shared/project-git";
import { api } from "../api";
import { ErrorBox, Spinner } from "../components/UI";

export default function GitDiffView({
  path,
  revision,
  open,
}: {
  path: string | null;
  revision: string;
  open: boolean;
}) {
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setDiff(null);
    setError("");
    if (path && open)
      void api<GitDiff>(
        `/api/project/git/diff?path=${encodeURIComponent(path)}`,
        { signal: controller.signal },
      ).then(
        (value) => {
          if (!controller.signal.aborted) setDiff(value);
        },
        (cause) => {
          if (!controller.signal.aborted)
            setError(
              cause instanceof Error
                ? cause.message
                : "Не удалось загрузить diff",
            );
        },
      );
    return () => controller.abort();
  }, [path, revision, open, retry]);
  return (
    <section className="git-diff-panel" aria-label="Изменения файла">
      {!path ? (
        <div className="git-empty">
          Выберите файл, чтобы посмотреть изменения.
        </div>
      ) : (
        <>
          <div className="git-diff-heading" title={path}>
            {path}
          </div>
          {error ? (
            <ErrorBox
              actions={
                <button
                  type="button"
                  className="button"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  Повторить
                </button>
              }
            >
              <span>{error}</span>
            </ErrorBox>
          ) : !diff ? (
            <div className="git-empty" role="status">
              <Spinner /> Загружаем изменения…
            </div>
          ) : (
            <>
              {diff.binary ? (
                <div className="git-empty">
                  Двоичный файл: текстовый diff недоступен.
                </div>
              ) : diff.patch ? (
                <pre
                  className="git-diff"
                  tabIndex={0}
                  aria-label={`Diff ${path}`}
                >
                  <code>
                    {diff.patch.split("\n").map((line, index) => (
                      <span
                        key={index}
                        className={
                          line.startsWith("+") && !line.startsWith("+++")
                            ? "git-line-added"
                            : line.startsWith("-") && !line.startsWith("---")
                              ? "git-line-removed"
                              : line.startsWith("@@")
                                ? "git-line-hunk"
                                : ""
                        }
                      >
                        {line}
                        {"\n"}
                      </span>
                    ))}
                  </code>
                </pre>
              ) : (
                <div className="git-empty">Текстовых изменений нет.</div>
              )}
              {diff.truncated && (
                <p className="git-diff-notice">
                  Показана часть diff: файл слишком большой. Коммит включает
                  файл целиком.
                </p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
