import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { AgentTargetContext, ProjectEvent } from "../../shared/agents";
import { openEventStream } from "../api";
import { parseEventFrames } from "./events";
type Surface = {
  context: () => AgentTargetContext;
  flush: () => Promise<void>;
};
export class ProjectSync {
  private surfaces = new Map<string, Surface>();
  private listeners = new Set<(event: ProjectEvent) => void>();
  private rehydrators = new Set<() => void>();
  register(name: string, surface: Surface) {
    this.surfaces.set(name, surface);
    return () => {
      if (this.surfaces.get(name) === surface) this.surfaces.delete(name);
    };
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
    for (const fn of this.listeners) fn(event);
  }
  rehydrate() {
    for (const fn of this.rehydrators) fn();
  }
  async prepare(): Promise<AgentTargetContext> {
    // Capture focus before the first asynchronous save. A later focus change never retargets this message.
    const targets = [...this.surfaces.values()].map((surface) => ({
      surface,
      context: surface.context(),
    }));
    const context = Object.assign(
      {},
      ...targets.map((t) => t.context),
    ) as AgentTargetContext;
    await Promise.all(targets.map((t) => t.surface.flush()));
    return context;
  }
}
export const ProjectSyncContext = createContext<ProjectSync | null>(null);
const Context = ProjectSyncContext;
export const useProjectSync = () => useContext(Context);
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
