export type Pane = "sql" | "board" | "presentation";
export type PairMode = "split" | "sql-presentation" | "board-presentation";
export type PaneMode = Pane | PairMode | "none";

export const PANE_ORDER: readonly Pane[] = ["sql", "board", "presentation"];
export const PANES_BY_MODE: Record<PaneMode, readonly Pane[]> = {
  split: ["sql", "board"],
  "sql-presentation": ["sql", "presentation"],
  "board-presentation": ["board", "presentation"],
  sql: ["sql"],
  board: ["board"],
  presentation: ["presentation"],
  none: [],
};

export const PANE_MIN_WIDTH: Record<Pane, number> = {
  sql: 340,
  board: 400,
  presentation: 400,
};

const PAIR_DEFAULTS: Record<PairMode, number> = {
  split: 45,
  "sql-presentation": 45,
  "board-presentation": 50,
};

export function isPaneMode(value: unknown): value is PaneMode {
  return typeof value === "string" && Object.hasOwn(PANES_BY_MODE, value);
}

export function isPairMode(mode: PaneMode): mode is PairMode {
  return PANES_BY_MODE[mode].length === 2;
}

export interface PaneView {
  mode: PaneMode;
  focusedPane: Pane | null;
}

export function selectPaneMode(view: PaneView, mode: PaneMode): PaneView {
  if (view.mode === mode) return view;
  const panes = PANES_BY_MODE[mode];
  const focusedPane =
    view.focusedPane && panes.includes(view.focusedPane)
      ? view.focusedPane
      : (panes[0] ?? null);
  return { mode, focusedPane };
}

export function setPaneVisible(view: PaneView, pane: Pane, visible?: boolean) {
  const panes = PANES_BY_MODE[view.mode];
  const shown = panes.includes(pane);
  if (shown === (visible ?? !shown)) return view;
  const next = shown
    ? panes.filter((item) => item !== pane)
    : panes.length === 2
      ? [view.focusedPane ?? panes[0]!, pane]
      : [...panes, pane];
  const mode = (Object.keys(PANES_BY_MODE) as PaneMode[]).find((candidate) => {
    const matches = PANES_BY_MODE[candidate];
    return (
      matches.length === next.length &&
      matches.every((item) => next.includes(item))
    );
  });
  return selectPaneMode(view, mode ?? "none");
}

function pairStorageKey(workspaceId: string, mode: PairMode) {
  const prefix = `miracle:workspace-layout:${workspaceId}`;
  return mode === "split" ? prefix : `${prefix}:${mode}`;
}

export function readPaneLayout(
  workspaceId: string,
  mode: PaneMode,
): Record<Pane, number> {
  const layout = { sql: 0, board: 0, presentation: 0 };
  const [left, right] = PANES_BY_MODE[mode];
  if (left && right && isPairMode(mode)) {
    try {
      const saved = JSON.parse(
        localStorage.getItem(pairStorageKey(workspaceId, mode)) ?? "null",
      );
      if (validPairSizes(saved, left, right)) {
        layout[left] = saved[left];
        layout[right] = saved[right];
        return layout;
      }
    } catch {}
    layout[left] = PAIR_DEFAULTS[mode];
    layout[right] = 100 - layout[left];
  } else {
    // The resize group requires a 100% starting layout even while hidden.
    layout[left ?? "sql"] = 100;
  }
  return layout;
}

export function savePaneLayout(
  workspaceId: string,
  mode: PairMode,
  layout: Record<string, number>,
) {
  const [left, right] = PANES_BY_MODE[mode];
  if (left && right && validPairSizes(layout, left, right)) {
    localStorage.setItem(
      pairStorageKey(workspaceId, mode),
      JSON.stringify({
        [left]: layout[left],
        [right]: layout[right],
      }),
    );
  }
}

export function resetPaneLayout(workspaceId: string, mode: PairMode) {
  localStorage.removeItem(pairStorageKey(workspaceId, mode));
}

function validPairSizes(
  layout: Record<string, number> | null,
  left: Pane,
  right: Pane,
) {
  const a = layout?.[left];
  const b = layout?.[right];
  return (
    typeof a === "number" &&
    typeof b === "number" &&
    a > 5 &&
    b > 5 &&
    Math.abs(a + b - 100) < 0.1
  );
}
