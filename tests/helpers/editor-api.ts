import type { EditorDocument } from "../../src/shared/agents";
/** A revisioned editor service for the SQL UI fixtures; query endpoints remain real mocks. */
export function editorApi(
  fallback: (path: string, options: RequestInit) => Promise<Response>,
  workspace: () => string,
) {
  const projects = new Map<string, Map<string, EditorDocument>>();
  return async (path: string, options: RequestInit = {}) => {
    if (!path.startsWith("/api/editor-documents"))
      return fallback(path, options);
    let documents = projects.get(workspace());
    if (!documents) {
      documents = new Map();
      projects.set(workspace(), documents);
    }
    const body = options.body ? JSON.parse(options.body as string) : {};
    const reply = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status });
    if (path === "/api/editor-documents/import") {
      for (const tab of body.documents) {
        if (!documents.has(tab.id))
          documents.set(tab.id, {
            ...tab,
            queryRevision: tab.revision,
            revision: 1,
            updatedAt: "now",
          });
      }
      return reply([...documents.values()]);
    }
    if (path === "/api/editor-documents") {
      if (!options.method) return reply([...documents.values()]);
      const doc = { ...body, revision: 1, updatedAt: "now" } as EditorDocument;
      documents.set(doc.id, doc);
      return reply(doc);
    }
    const id = path.split("/").pop()!,
      old = documents.get(id);
    if (!old) return reply({ error: "Missing document" }, 404);
    if (body.baseRevision !== old.revision)
      return reply({ error: "Revision conflict" }, 409);
    if (options.method === "DELETE") {
      documents.delete(id);
      return new Response(null, { status: 204 });
    }
    const doc = Object.fromEntries(
      Object.entries({ ...old, ...body, revision: old.revision + 1 }).filter(
        ([, value]) => value !== null,
      ),
    ) as unknown as EditorDocument;
    documents.set(id, doc);
    return reply(doc);
  };
}
