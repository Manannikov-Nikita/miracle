import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { describeError, type ErrorContext } from "../error-message";
import * as Dialog from "@radix-ui/react-dialog";
import {
  X,
  CircleNotch,
  WarningCircle,
  ArrowRight,
  Check,
} from "@phosphor-icons/react";
export function IconButton({
  label,
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={`icon-button ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
  dismissible = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
  dismissible?: boolean;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (value || dismissible) onOpenChange(value);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop" />
        <Dialog.Content
          className={`modal ${wide ? "modal-wide" : ""}`}
          aria-describedby={description ? "modal-description" : undefined}
          onEscapeKeyDown={(event) => {
            if (!dismissible) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (!dismissible) event.preventDefault();
          }}
        >
          <div className="modal-heading">
            <div>
              <Dialog.Title className="modal-title">{title}</Dialog.Title>
              {description && (
                <Dialog.Description id="modal-description" className="muted">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <IconButton label="Закрыть" disabled={!dismissible}>
                <X size={18} />
              </IconButton>
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Spinner() {
  return <CircleNotch size={16} className="spin" aria-label="Загрузка" />;
}
export function ErrorBox({
  error,
  children,
  context,
  engine,
  title,
  hint,
  actions,
  className = "",
}: {
  error?: unknown;
  children?: ReactNode;
  context?: ErrorContext;
  engine?: "clickhouse" | "trino";
  title?: string;
  hint?: string;
  actions?: ReactNode;
  className?: string;
}) {
  const diagnostic =
    error !== undefined || typeof children === "string"
      ? describeError(error ?? children, { context, engine })
      : undefined;
  return (
    <div className={`error-box ${className}`} role="alert">
      <WarningCircle size={18} aria-hidden="true" />
      <div className="error-content">
        {diagnostic ? (
          <>
            <strong className="error-title">{title ?? diagnostic.title}</strong>
            <p className="error-hint">{hint ?? diagnostic.hint}</p>
            {diagnostic.details && (
              <details className="error-details" key={diagnostic.details}>
                <summary>Полный текст ошибки</summary>
                <pre>{diagnostic.details}</pre>
              </details>
            )}
          </>
        ) : (
          children
        )}
        {actions && <div className="error-actions">{actions}</div>}
      </div>
    </div>
  );
}
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Brand({ large = false }: { large?: boolean }) {
  return (
    <div className={`brand ${large ? "brand-large" : ""}`}>
      <span className="brand-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>
        miracle<span className="brand-period">.</span>
      </span>
    </div>
  );
}
export function Toasts({
  items,
  onDismiss,
}: {
  items: { id: number; message: string; tone: string }[];
  onDismiss: (id: number) => void;
}) {
  // Keep a snapshot so an expiring toast cannot remove diagnostics mid-read.
  const [selectedError, setSelectedError] =
    useState<ReturnType<typeof describeError>>();
  return (
    <>
      <div className="toasts" aria-live="polite">
        {items.map((t) => {
          const diagnostic =
            t.tone === "error" ? describeError(t.message) : undefined;
          return (
            <div key={t.id} className={`toast toast-${t.tone}`}>
              {t.tone === "error" ? (
                <WarningCircle size={18} />
              ) : t.tone === "success" ? (
                <Check size={18} />
              ) : (
                <ArrowRight size={18} />
              )}
              <span>
                {diagnostic ? (
                  <>
                    <strong className="error-title">{diagnostic.title}</strong>
                    <span className="error-hint">{diagnostic.hint}</span>
                  </>
                ) : (
                  t.message
                )}
              </span>
              {diagnostic && (
                <button
                  type="button"
                  className="toast-details"
                  onClick={() => setSelectedError(diagnostic)}
                >
                  Подробнее
                </button>
              )}
              <IconButton
                label="Закрыть уведомление"
                onClick={() => onDismiss(t.id)}
              >
                <X size={14} />
              </IconButton>
            </div>
          );
        })}
      </div>
      <Modal
        open={!!selectedError}
        onOpenChange={(open) => {
          if (!open) setSelectedError(undefined);
        }}
        title={selectedError?.title ?? "Ошибка"}
        description={selectedError?.hint}
      >
        <pre className="error-full-text">{selectedError?.details}</pre>
      </Modal>
    </>
  );
}
