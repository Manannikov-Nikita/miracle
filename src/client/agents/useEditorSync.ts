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
import { currentAgentWork, editorAgentWork } from "./useAgentWork";
export const recoveryKey = (workspaceId: string) =>
  `miracle:sql-recovery:${workspaceId}`;

// Leave room for the migration id and JSON envelope. Large individual drafts
// use the migration route's dedicated 8 MiB limit (1M SQL chars can be 6M
// escaped JSON bytes); ordinary batches stay below 1 MiB and 200 documents.
const importBatchBytes = 1024 * 1024 - 256;
const importDocumentBytes = 8 * 1024 * 1024 - 256;
function importBatches(legacy: EditorTab[]): EditorTab[][] {
  const batches: EditorTab[][] = [];
  let batch: EditorTab[] = [],
    bytes = 0;
  const encoder = new TextEncoder();
  for (const document of legacy) {
    const size = encoder.encode(json(document)).byteLength + 1;
    if (size > importDocumentBytes)
      throw new Error(
        `Черновик «${document.name || "SQL"}» слишком велик для переноса. Исходный текст сохранён в браузере.`,
      );
    if (
      batch.length &&
      (bytes + size > importBatchBytes || batch.length === 200)
    ) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(document);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
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
      for (const batch of importBatches(legacy)) {
        // A lost reply can follow a successful commit. Content-based batch ids
        // replay that commit safely, even if old tabs were added before retry.
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(json(batch)),
        );
        const batchId = [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        documents = await api<EditorDocument[]>(
          "/api/editor-documents/import",
          {
            method: "POST",
            body: json({
              migrationId: `${migrationId}:${batchId}`,
              documents: batch,
            }),
          },
        );
      }
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
  filePathForTab?: (id: string) => string | undefined,
) {
  const project = useProjectSync();
  const filePath = useRef(filePathForTab);
  filePath.current = filePathForTab;
  const lockCheck = useRef<(tab: EditorTab) => boolean>(() => false);
  const reconciling = useRef(0);
  lockCheck.current = (tab) =>
    reconciling.current > 0 ||
    Boolean(
      editorAgentWork(currentAgentWork(project), tab, filePathForTab?.(tab.id)),
    );
  const [tick, update] = useState(0);
  const [error, setError] = useState("");
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const syncRef = useRef<EditorSync | null>(null);
  if (!syncRef.current) {
    syncRef.current = new EditorSync(
      documents,
      api,
      (next) => {
        setTabs(next);
        update((n) => n + 1);
      },
      (tab) => lockCheck.current(tab),
    );
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
    const refresh = () => {
      const revisions = sync.revisions();
      reconciling.current++;
      return api<EditorDocument[]>("/api/editor-documents")
        .then((docs) => {
          sync.reconcile(docs, revisions);
          return true;
        })
        .catch((e) => {
          setError(e.message);
          return false;
        })
        .finally(() => {
          reconciling.current--;
        });
    };
    const reconnect = project.onReconnect(() => {
      void refresh().then((ok) => {
        if (ok) void saveRef.current().catch(() => {});
      });
    });
    let previous = currentAgentWork(project);
    const workChanged = project.subscribeWork?.((snapshot) => {
      const released = previous.some(
        (work) =>
          sync.tabs.some((tab) =>
            editorAgentWork([work], tab, filePath.current?.(tab.id)),
          ) &&
          !snapshot.locks.some(
            (next) =>
              next.turnId === work.turnId &&
              JSON.stringify(next.target) === JSON.stringify(work.target),
          ),
      );
      previous = snapshot.locks;
      if (released)
        void refresh().then((ok) => {
          if (ok) void saveRef.current().catch(() => {});
        });
    });
    return () => {
      changed();
      reconnect();
      workChanged?.();
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
