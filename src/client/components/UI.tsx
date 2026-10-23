import { type ButtonHTMLAttributes, type ReactNode } from "react";
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop" />
        <Dialog.Content
          className={`modal ${wide ? "modal-wide" : ""}`}
          aria-describedby={description ? "modal-description" : undefined}
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
              <IconButton label="Закрыть">
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
export function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div className="error-box" role="alert">
      <WarningCircle size={18} />
      <span>{children}</span>
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
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`}>
          {t.tone === "error" ? (
            <WarningCircle size={18} />
          ) : t.tone === "success" ? (
            <Check size={18} />
          ) : (
            <ArrowRight size={18} />
          )}
          <span>{t.message}</span>
          <IconButton
            label="Закрыть уведомление"
            onClick={() => onDismiss(t.id)}
          >
            <X size={14} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
