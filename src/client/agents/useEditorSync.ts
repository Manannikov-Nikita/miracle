import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { EditorDocument } from "../../shared/agents";
import { api, json } from "../api";
import { EditorSync, type EditorTab } from "./editor-sync";
import { useProjectSync } from "./ProjectSync";
export const recoveryKey = (workspaceId: string) =>
  `miracle:sql-recovery:${workspaceId}`;
export async function loadEditorDocuments(
  workspaceId: string,
): Promise<EditorDocument[]> {
  let documents = await api<EditorDocument[]>("/api/editor-documents");
  const key = `miracle:sql-tabs:${workspaceId}`;
  if (localStorage.getItem(`${key}:imported`) !== "1") {
    let legacy: EditorTab[] = [];
    try {
      const stored = JSON.parse(localStorage.getItem(key) || "[]");
      if (Array.isArray(stored)) legacy = stored;
    } catch {}
    if (legacy.length) {
      let migrationId = localStorage.getItem(`${key}:migration-id`);
      if (!migrationId) {
        migrationId = crypto.randomUUID();
        localStorage.setItem(`${key}:migration-id`, migrationId);
      }
      documents = await api<EditorDocument[]>("/api/editor-documents/import", {
        method: "POST",
        body: json({
          migrationId,
          documents: legacy,
        }),
      });
    }
    // The old drafts remain until the authoritative import has acknowledged them.
    localStorage.setItem(`${key}:imported`, "1");
  }
  return documents;
}
export function useEditorSync(
  workspaceId: string,
  documents: EditorDocument[],
  tabs: EditorTab[],
  setTabs: Dispatch<SetStateAction<EditorTab[]>>,
  notify: (message: string, tone?: "error" | "success" | "info") => void,
) {
  const project = useProjectSync();
  const [tick, update] = useState(0);
  const [error, setError] = useState("");
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const syncRef = useRef<EditorSync | null>(null);
  if (!syncRef.current) {
    syncRef.current = new EditorSync(documents, api, (next) => {
      setTabs(
        next.length
          ? next
          : [
              {
                id: crypto.randomUUID(),
                name: "query_1.sql",
                sql: "",
                connectionId: "",
              },
            ],
      );
      update((n) => n + 1);
    });
    syncRef.current.restore(tabs);
  }
  const sync = syncRef.current;
  sync.local(tabs);
  const saveRef = useRef<() => Promise<void>>(async () => {});
  saveRef.current = async () => {
    try {
      await sync.flush();
      setError("");
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  };
  useEffect(() => {
    const persist = () => {
      try {
        localStorage.setItem(
          recoveryKey(workspaceId),
          json(
            sync.tabs.filter(
              (tab) => sync.dirty(tab) || sync.conflicts.has(tab.id),
            ),
          ),
        );
      } catch {
        notifyRef.current(
          "Не удалось сохранить резервный SQL-черновик в браузере",
          "error",
        );
      }
    };
    persist();
    const timer = setTimeout(() => void saveRef.current().catch(() => {}), 500);
    return () => clearTimeout(timer);
  }, [tabs, workspaceId]);
  useEffect(() => {
    if (!project) return;
    const changed = project.subscribe((event) => {
      if (event.type === "editor.updated")
        sync.receive(event.data as EditorDocument);
      if (event.type === "editor.deleted")
        sync.deleted(event.entityId || (event.data as { id: string }).id);
    });
    const reconnect = project.onReconnect(() => {
      const revisions = sync.revisions();
      void api<EditorDocument[]>("/api/editor-documents")
        .then((docs) => sync.reconcile(docs, revisions))
        .catch((e) => setError(e.message));
    });
    return () => {
      changed();
      reconnect();
    };
  }, [project, sync]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (sync.tabs.some((t) => sync.dirty(t))) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [sync]);
  return { sync, error, flush: () => saveRef.current(), tick };
}
