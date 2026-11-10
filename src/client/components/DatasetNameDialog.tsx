import { useRef, useState } from "react";
import { DATASET_NAME_PATTERN } from "../../shared/datasets";
import { describeError } from "../error-message";
import { ErrorBox, Modal } from "./UI";

export default function DatasetNameDialog({
  title,
  initialName,
  confirmLabel = "Сохранить",
  onConfirm,
  onClose,
}: {
  title: string;
  initialName: string;
  confirmLabel?: string;
  onConfirm(name: string): Promise<void>;
  onClose(): void;
}) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const trigger = useRef(document.activeElement);
  const valid = DATASET_NAME_PATTERN.test(name.trim());

  async function submit() {
    if (pending.current || !valid) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await onConfirm(name.trim());
      onClose();
    } catch (error) {
      setError(describeError(error).details);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={title}
      description="Это имя можно использовать в SQL-запросах к файлам и датасетам проекта."
      dismissible={!busy}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onCloseAutoFocus={(event) => {
        if (
          !(trigger.current instanceof HTMLElement) ||
          !trigger.current.isConnected
        )
          return;
        event.preventDefault();
        trigger.current.focus();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label>
          Имя датасета
          <input
            autoFocus
            value={name}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
            maxLength={63}
          />
        </label>
        <small className="muted">
          Латинские буквы, цифры и подчёркивания. Имя начинается с буквы или
          подчёркивания.
        </small>
        {error && <ErrorBox error={error} />}
        <div className="modal-actions">
          <button
            type="button"
            className="button"
            onClick={onClose}
            disabled={busy}
          >
            Отмена
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={busy || !valid}
          >
            {busy ? "Сохранение…" : confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
