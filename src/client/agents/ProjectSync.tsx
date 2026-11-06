import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { AgentTargetContext, ProjectEvent } from "../../shared/agents";
import type { AgentWorkSnapshot } from "../../shared/agent-work";
import { api, openEventStream } from "../api";
import { parseEventFrames } from "./events";
export type OpenEditorTab = { id: string; name: string; path?: string };
type Surface = {
  context: () => AgentTargetContext;
  editorTabs?: () => OpenEditorTab[];
  flush: (context?: AgentTargetContext) => Promise<void>;
};
export class ProjectSync {
  private work: AgentWorkSnapshot = { revision: -1, locks: [] };
  private workListeners = new Set<(snapshot: AgentWorkSnapshot) => void>();
  constructor(
    private loadWork: () => Promise<AgentWorkSnapshot> = () =>
      api("/api/agent-work"),
  ) {}
  workSnapshot() {
    return this.work;
  }
  subscribeWork(fn: (snapshot: AgentWorkSnapshot) => void) {
    this.workListeners.add(fn);
    return () => {
      this.workListeners.delete(fn);
    };
  }
  receiveWorkSnapshot(snapshot: AgentWorkSnapshot) {
    if (
      !snapshot ||
      !Number.isSafeInteger(snapshot.revision) ||
      !Array.isArray(snapshot.locks) ||
      snapshot.revision <= this.work.revision
    )
      return;
    this.work = snapshot;
    for (const fn of this.workListeners) fn(snapshot);
  }
  async hydrateWork() {
    this.receiveWorkSnapshot(await this.loadWork());
  }
  private surfaces = new Map<string, Surface>();
  private listeners = new Set<(event: ProjectEvent) => void>();
  private rehydrators = new Set<() => void>();
  private contextListeners = new Set<(context: AgentTargetContext) => void>();
  private editorTabListeners = new Set<(tabs: OpenEditorTab[]) => void>();
  register(name: string, surface: Surface) {
    this.surfaces.set(name, surface);
    this.contextChanged();
    return () => {
      if (this.surfaces.get(name) === surface) {
        this.surfaces.delete(name);
        this.contextChanged();
      }
    };
  }
  context(): AgentTargetContext {
    return structuredClone(
      Object.assign(
        {},
        ...[...this.surfaces.values()].map((surface) => surface.context()),
      ),
    );
  }
  subscribeContext(fn: (context: AgentTargetContext) => void) {
    this.contextListeners.add(fn);
    return () => {
      this.contextListeners.delete(fn);
    };
  }
  contextChanged() {
    const context = this.context();
    for (const fn of this.contextListeners) fn(context);
    this.editorTabsChanged();
  }
  editorTabs(): OpenEditorTab[] {
    return structuredClone(
      [...this.surfaces.values()].flatMap(
        (surface) => surface.editorTabs?.() || [],
      ),
    );
  }
  subscribeEditorTabs(fn: (tabs: OpenEditorTab[]) => void) {
    this.editorTabListeners.add(fn);
    return () => {
      this.editorTabListeners.delete(fn);
    };
  }
  editorTabsChanged() {
    const tabs = this.editorTabs();
    for (const fn of this.editorTabListeners) fn(tabs);
  }
  subscribe(fn: (event: ProjectEvent) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  onReconnect(fn: () => void) {
    this.rehydrators.add(fn);
    return () => {
      this.rehydrators.delete(fn);
    };
  }
  emit(event: ProjectEvent) {
    if (event.type === "agent.work")
      this.receiveWorkSnapshot({
        revision: event.id,
        locks: (event.data as AgentWorkSnapshot).locks,
      });
    for (const fn of this.listeners) fn(event);
  }
  rehydrate() {
    void this.hydrateWork().catch(() => {});
    for (const fn of this.rehydrators) fn();
  }
  async prepare(
    references: Partial<AgentTargetContext> = {},
  ): Promise<AgentTargetContext> {
    // Capture focus before the first asynchronous save. A later focus change never retargets this message.
    const targets = [...this.surfaces.values()].map((surface) => ({
      surface,
      context: surface.context(),
    }));
    const context = structuredClone(
      Object.assign({}, ...targets.map((t) => t.context), references),
    ) as AgentTargetContext;
    await Promise.all(targets.map((t) => t.surface.flush(context)));
    return context;
  }
}
export const ProjectSyncContext = createContext<ProjectSync | null>(null);
const Context = ProjectSyncContext;
export const useProjectSync = () => useContext(Context);
export function useOpenEditorTabs(): OpenEditorTab[] {
  const project = useProjectSync();
  const [tabs, setTabs] = useState<OpenEditorTab[]>(
    () => project?.editorTabs?.() || [],
  );
  useEffect(() => {
    const update = (next: OpenEditorTab[]) =>
      setTabs((current) =>
        JSON.stringify(current) === JSON.stringify(next) ? current : next,
      );
    update(project?.editorTabs?.() || []);
    return project?.subscribeEditorTabs?.(update);
  }, [project]);
  return tabs;
}
export function useProjectTargetContext() {
  const project = useProjectSync();
  const [context, setContext] = useState<AgentTargetContext>(
    () => project?.context() || {},
  );
  useEffect(() => {
    const update = (next: AgentTargetContext) =>
      setContext((current) =>
        JSON.stringify(current) === JSON.stringify(next) ? current : next,
      );
    update(project?.context() || {});
    return project?.subscribeContext(update);
  }, [project]);
  return context;
}
export function ProjectSyncProvider({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  const sync = useMemo(() => new ProjectSync(), [workspaceId]);
  const [connected, setConnected] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    let cursor = 0,
      timer: ReturnType<typeof setTimeout> | undefined;
    void sync.hydrateWork().catch(() => {});
    const reconnect = async () => {
      while (!controller.signal.aborted) {
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          const response = await openEventStream(cursor, controller.signal);
          reader = response.body?.getReader();
          if (!reader) throw new Error("Поток событий недоступен");
          setConnected(true);
          sync.rehydrate();
          let buffer = "";
          const decoder = new TextDecoder();
          while (!controller.signal.aborted) {
            const { value, done } = await reader.read();
            if (done) throw new Error("Связь прервалась");
            buffer += decoder.decode(value, { stream: true });
            const parsed = parseEventFrames(buffer, cursor);
            buffer = parsed.rest;
            cursor = parsed.cursor;
            for (const event of parsed.events) sync.emit(event);
          }
        } catch {
          if (controller.signal.aborted) return;
          setConnected(false);
        } finally {
          await reader?.cancel().catch(() => {});
        }
        await new Promise<void>((resolve) => {
          const abort = () => resolve();
          timer = setTimeout(() => {
            controller.signal.removeEventListener("abort", abort);
            resolve();
          }, 1500);
          controller.signal.addEventListener("abort", abort, { once: true });
        });
      }
    };
    void reconnect();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [sync]);
  return (
    <Context.Provider value={sync}>
      {!connected && (
        <div className="project-connection-status" role="status">
          Переподключаемся к проекту… Черновики сохранены в браузере.
        </div>
      )}
      {children}
    </Context.Provider>
  );
}
