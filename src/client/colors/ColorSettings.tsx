import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Palette,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import { IconButton, Modal } from "../components/UI";
import ColorPicker from "./ColorPicker";
import {
  MAX_SAVED_COLORS,
  useSavedColors,
  type SavedColor,
} from "./saved-colors";
import "./color-settings.css";

type PaletteActions = ReturnType<typeof useSavedColors>;

function SavedColorRow({
  entry,
  index,
  count,
  update,
  remove,
  move,
}: {
  entry: SavedColor;
  index: number;
  count: number;
} & Pick<PaletteActions, "update" | "remove" | "move">) {
  const [name, setName] = useState(entry.name);
  const nameDirty = useRef(false);
  useEffect(() => {
    if (!nameDirty.current) setName(entry.name);
  }, [entry.name]);

  function saveName() {
    if (name.trim() === entry.name) {
      nameDirty.current = false;
      setName(entry.name);
    } else if (update(entry.id, { name })) {
      nameDirty.current = false;
      setName(name.trim() || entry.color);
    }
  }

  return (
    <li className="saved-color-row">
      <ColorPicker
        value={entry.color}
        onChange={(color) => update(entry.id, { color })}
        label={`Изменить цвет · ${entry.name}`}
        compact
      />
      <div className="saved-color-fields">
        <input
          aria-label={`Название цвета · ${entry.name}`}
          value={name}
          maxLength={80}
          spellCheck={false}
          onChange={(event) => {
            nameDirty.current = true;
            setName(event.target.value);
          }}
          onBlur={saveName}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              saveName();
            }
          }}
        />
        <code>{entry.color}</code>
      </div>
      <div className="saved-color-actions">
        <IconButton
          label={`Переместить выше · ${entry.name}`}
          disabled={index === 0}
          onClick={() => move(entry.id, -1)}
        >
          <ArrowUp size={15} />
        </IconButton>
        <IconButton
          label={`Переместить ниже · ${entry.name}`}
          disabled={index === count - 1}
          onClick={() => move(entry.id, 1)}
        >
          <ArrowDown size={15} />
        </IconButton>
        <IconButton
          label={`Удалить цвет · ${entry.name}`}
          onClick={() => remove(entry.id)}
        >
          <Trash size={15} />
        </IconButton>
      </div>
    </li>
  );
}

export default function ColorSettings({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const palette = useSavedColors();
  const [newColor, setNewColor] = useState("#83F3C0");
  const [newName, setNewName] = useState("");
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (open && !wasOpen.current)
      opener.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    wasOpen.current = open;
  }, [open]);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Настройки"
      description="Личные настройки Miracle"
      className="color-settings"
      onCloseAutoFocus={(event) => {
        if (opener.current?.isConnected) {
          event.preventDefault();
          opener.current.focus();
        }
      }}
    >
      <section
        className="color-settings-section"
        aria-label="Сохранённые цвета"
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div className="color-settings-heading">
          <div>
            <h3>Сохранённые цвета</h3>
            <p>Цвета сохраняются для этого адреса Miracle в браузере.</p>
          </div>
          <span
            className="color-settings-count"
            aria-label={`Сохранено цветов: ${palette.colors.length} из ${MAX_SAVED_COLORS}`}
          >
            {palette.colors.length} / {MAX_SAVED_COLORS}
          </span>
        </div>

        {palette.error && (
          <p className="color-settings-error" role="alert">
            {palette.error}
          </p>
        )}

        <form
          className="color-settings-add"
          onSubmit={(event) => {
            event.preventDefault();
            if (palette.add(newColor, newName)) setNewName("");
          }}
        >
          <ColorPicker
            value={newColor}
            onChange={setNewColor}
            label="Новый цвет"
            compact
          />
          <div className="saved-color-fields">
            <input
              aria-label="Название нового цвета"
              placeholder="Название цвета"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              maxLength={80}
            />
            <code>{newColor}</code>
          </div>
          <button
            type="submit"
            className="button small color-settings-add-button"
            disabled={palette.colors.length >= MAX_SAVED_COLORS}
          >
            <Plus size={15} aria-hidden="true" />
            Добавить цвет
          </button>
        </form>

        {palette.colors.length === 0 ? (
          <div className="color-settings-empty">
            <Palette size={26} aria-hidden="true" />
            <strong>Добавьте первый цвет</strong>
            <p>
              Выберите оттенок выше или нажмите «+» в любом колор-пикере. Цвет
              появится во всей вашей палитре.
            </p>
          </div>
        ) : (
          <ul className="saved-color-list" aria-label="Палитра">
            {palette.colors.map((entry, index) => (
              <SavedColorRow
                key={entry.id}
                entry={entry}
                index={index}
                count={palette.colors.length}
                update={palette.update}
                remove={palette.remove}
                move={palette.move}
              />
            ))}
          </ul>
        )}
        <p className="color-settings-note">
          Изменения сохраняются сразу. Редактирование образца не меняет цвета
          уже оформленных объектов.
        </p>
      </section>
    </Modal>
  );
}
