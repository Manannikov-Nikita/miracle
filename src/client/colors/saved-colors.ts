import { useSyncExternalStore } from "react";

export interface SavedColor {
  id: string;
  name: string;
  color: string;
}

export const SAVED_COLORS_STORAGE_KEY = "miracle.saved-colors.v1";
export const MAX_SAVED_COLORS = 64;
const MAX_NAME_LENGTH = 80;
const STORAGE_ERROR =
  "Не удалось сохранить палитру. Разрешите хранение данных в браузере и повторите попытку.";
const CORRUPT_ERROR =
  "Часть сохранённой палитры повреждена. Доступные цвета восстановлены; изменения сохранят исправленную палитру.";

interface Snapshot {
  colors: SavedColor[];
  error: string | null;
}

const emptySnapshot: Snapshot = { colors: [], error: null };

function normalizeColor(value: string): string | null {
  const hex = value.trim();
  if (/^#[\da-f]{6}$/i.test(hex)) return hex.toUpperCase();
  if (/^#[\da-f]{3}$/i.test(hex)) {
    return `#${hex
      .slice(1)
      .split("")
      .map((digit) => digit + digit)
      .join("")}`.toUpperCase();
  }
  return null;
}

function parseColors(raw: string | null): Snapshot {
  if (raw === null) return emptySnapshot;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { colors: [], error: CORRUPT_ERROR };
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    !("version" in payload) ||
    payload.version !== 1 ||
    !("colors" in payload) ||
    !Array.isArray(payload.colors)
  ) {
    return { colors: [], error: CORRUPT_ERROR };
  }
  const colors: SavedColor[] = [];
  const ids = new Set<string>();
  const values = new Set<string>();
  let corrupt = false;
  for (const entry of payload.colors) {
    const color =
      typeof entry?.color === "string" ? normalizeColor(entry.color) : null;
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !entry.id ||
      typeof entry.name !== "string" ||
      entry.name.length > MAX_NAME_LENGTH ||
      !color ||
      ids.has(entry.id) ||
      values.has(color) ||
      colors.length >= MAX_SAVED_COLORS
    ) {
      corrupt = true;
      continue;
    }
    colors.push({ id: entry.id, name: entry.name.trim() || color, color });
    ids.add(entry.id);
    values.add(color);
  }
  return { colors, error: corrupt ? CORRUPT_ERROR : null };
}

function createStore(browser: Window) {
  let snapshot = emptySnapshot;
  const listeners = new Set<() => void>();

  function publish(next: Snapshot) {
    if (
      snapshot.error === next.error &&
      JSON.stringify(snapshot.colors) === JSON.stringify(next.colors)
    )
      return;
    snapshot = next;
    listeners.forEach((listener) => listener());
  }

  function refresh(): boolean {
    try {
      publish(
        parseColors(browser.localStorage.getItem(SAVED_COLORS_STORAGE_KEY)),
      );
      return true;
    } catch {
      publish({ colors: snapshot.colors, error: STORAGE_ERROR });
      return false;
    }
  }

  function fail(error: string): false {
    publish({ colors: snapshot.colors, error });
    return false;
  }

  function persist(colors: SavedColor[]): boolean {
    try {
      browser.localStorage.setItem(
        SAVED_COLORS_STORAGE_KEY,
        JSON.stringify({ version: 1, colors }),
      );
      publish({ colors, error: null });
      return true;
    } catch {
      return fail(STORAGE_ERROR);
    }
  }

  function onStorage(event: StorageEvent) {
    if (event.key !== null && event.key !== SAVED_COLORS_STORAGE_KEY) return;
    try {
      if (event.storageArea && event.storageArea !== browser.localStorage)
        return;
    } catch {
      // refresh reports blocked storage without crashing subscribers.
    }
    refresh();
  }

  refresh();

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (listeners.size === 0) {
        browser.addEventListener("storage", onStorage);
        refresh();
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0)
          browser.removeEventListener("storage", onStorage);
      };
    },
    add(value: string, name = ""): boolean {
      if (!refresh()) return false;
      const color = normalizeColor(value);
      if (!color) return fail("Укажите цвет в формате HEX, например #83F3C0.");
      if (snapshot.colors.some((entry) => entry.color === color))
        return fail("Этот цвет уже есть в палитре.");
      if (snapshot.colors.length >= MAX_SAVED_COLORS)
        return fail(
          "В палитре может быть не больше 64 цветов. Удалите один, чтобы добавить новый.",
        );
      if (name.trim().length > MAX_NAME_LENGTH)
        return fail("Название цвета должно быть не длиннее 80 символов.");
      const id =
        browser.crypto.randomUUID?.() ??
        `color-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      return persist([
        ...snapshot.colors,
        { id, name: name.trim() || color, color },
      ]);
    },
    update(id: string, patch: { name?: string; color?: string }): boolean {
      if (!refresh()) return false;
      const current = snapshot.colors.find((entry) => entry.id === id);
      if (!current) return fail("Этот цвет уже удалён из палитры.");
      const color =
        patch.color === undefined ? current.color : normalizeColor(patch.color);
      if (!color) return fail("Укажите цвет в формате HEX, например #83F3C0.");
      if (
        snapshot.colors.some(
          (entry) => entry.id !== id && entry.color === color,
        )
      )
        return fail("Этот цвет уже есть в палитре.");
      const name =
        patch.name === undefined ? current.name : patch.name.trim() || color;
      if (name.length > MAX_NAME_LENGTH)
        return fail("Название цвета должно быть не длиннее 80 символов.");
      return persist(
        snapshot.colors.map((entry) =>
          entry.id === id ? { id, name, color } : entry,
        ),
      );
    },
    remove(id: string): boolean {
      if (!refresh()) return false;
      if (!snapshot.colors.some((entry) => entry.id === id))
        return fail("Этот цвет уже удалён из палитры.");
      return persist(snapshot.colors.filter((entry) => entry.id !== id));
    },
    move(id: string, direction: -1 | 1): boolean {
      if (!refresh()) return false;
      const index = snapshot.colors.findIndex((entry) => entry.id === id);
      const destination = index + direction;
      if (index < 0 || destination < 0 || destination >= snapshot.colors.length)
        return false;
      const colors = [...snapshot.colors];
      [colors[index], colors[destination]] = [
        colors[destination],
        colors[index],
      ];
      return persist(colors);
    },
  };
}

const stores = new WeakMap<Window, ReturnType<typeof createStore>>();
const serverStore = {
  getSnapshot: () => emptySnapshot,
  subscribe: () => () => {},
  add: (_color: string, _name?: string) => false,
  update: (_id: string, _patch: { name?: string; color?: string }) => false,
  remove: (_id: string) => false,
  move: (_id: string, _direction: -1 | 1) => false,
};

export function useSavedColors() {
  let store = typeof window === "undefined" ? serverStore : stores.get(window);
  if (!store) {
    store = createStore(window);
    stores.set(window, store);
  }
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    serverStore.getSnapshot,
  );
  return {
    ...snapshot,
    add: store.add,
    update: store.update,
    remove: store.remove,
    move: store.move,
  };
}
