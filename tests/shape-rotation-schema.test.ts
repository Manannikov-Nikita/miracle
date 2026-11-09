import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { boardDocumentSchema } from "../src/shared/board-schema";
import { resolveShape, shapeSpecSchema } from "../src/shared/shapes";
import { Database, migrate } from "../src/server/db";
import { SecretBox } from "../src/server/secrets";
import { ProjectStore } from "../src/server/project-store";
import { WorkspaceOperations } from "../src/server/workspace-operations";
import {
  createBoardFragment,
  pasteBoardFragment,
  readBoardClipboard,
  writeBoardClipboard,
} from "../src/client/board/clipboard";

describe("saved shape rotation", () => {
  it.each([0, 15, 127.25, 359.9, 360])(
    "keeps the explicit %s° angle",
    (rotation) => {
      const shape = { type: "line", rotation, lineEnd: "arrow" };
      expect(shapeSpecSchema.parse(shape)).toEqual(shape);
      expect(resolveShape(shapeSpecSchema.parse(shape)).rotation).toBe(
        rotation,
      );
    },
  );

  it.each([-1, 360.01, NaN, Infinity, -Infinity, "15", null])(
    "rejects an invalid persisted angle %s",
    (rotation) => {
      expect(
        shapeSpecSchema.safeParse({ type: "rectangle", rotation }).success,
      ).toBe(false);
    },
  );

  it("renders old shapes at zero degrees without adding fields to the saved object", () => {
    const legacy = shapeSpecSchema.parse({ type: "triangle", fill: "#123456" });
    expect(resolveShape(legacy).rotation).toBe(0);
    expect(legacy).toEqual({ type: "triangle", fill: "#123456" });
  });

  it.each(["board", "presentation"] as const)(
    "saves and copies a rotated shape in a %s without changing its geometry or style",
    (kind) => {
      const directory = mkdtempSync(join(tmpdir(), "miracle-rotation-"));
      const db = new Database(directory);
      migrate(db, () => {});
      const store = new ProjectStore(db, new SecretBox(Buffer.alloc(32, 1)), {
        projectRoot: directory,
        dataDir: directory,
        workspaceId: randomUUID(),
        instanceId: randomUUID(),
      });
      try {
        const operations = new WorkspaceOperations(store, async () => {});
        const shape = {
          type: "line",
          rotation: 127.25,
          lineDirection: "horizontal",
          lineEnd: "arrow",
          stroke: "#123456",
          strokeWidth: 3,
        };
        const input = {
          schemaVersion: 1,
          ...(kind === "presentation"
            ? {
                kind,
                slides: [
                  { id: "slide", title: "Слайд", background: "#ffffff" },
                ],
              }
            : {}),
          nodes: [
            {
              id: "rotated-line",
              type: "artifact",
              ...(kind === "presentation" ? { slideId: "slide" } : {}),
              position: { x: 100, y: 80 },
              width: 260,
              height: 40,
              data: { kind: "shape", title: "Линия", text: "", shape },
            },
          ],
          edges: [],
        };
        const created = operations.createBoard({
          name: "Поворот",
          document: input,
        });
        expect(operations.board(created.id).document).toEqual(input);
        const fragment = createBoardFragment(
          created,
          "workspace",
          new Set(["rotated-line"]),
          kind === "presentation" ? "slide" : undefined,
        );
        expect(fragment).not.toBeNull();
        const values = new Map<string, string>();
        const clipboard = {
          getData: (type: string) => values.get(type) ?? "",
          setData: (type: string, value: string) => {
            values.set(type, value);
          },
        };
        writeBoardClipboard(clipboard, fragment!);
        const copied = readBoardClipboard(clipboard);
        expect(copied).not.toBeNull();
        const pasted = pasteBoardFragment(
          copied!,
          created,
          { x: 600, y: 400 },
          0,
          kind === "presentation" ? { slideId: "slide" } : undefined,
        );
        const saved = operations.updateBoard(created.id, {
          baseRevision: created.revision,
          mutationId: randomUUID(),
          document: pasted.document,
        });
        const reloaded = boardDocumentSchema.parse(
          operations.board(saved.id).document,
        );
        expect(reloaded.nodes).toHaveLength(2);
        expect(reloaded.nodes[1].id).not.toBe("rotated-line");
        expect(reloaded.nodes[1].data.shape).toEqual(shape);
        expect(reloaded.nodes[1].width).toBe(260);
        expect(reloaded.nodes[1].height).toBe(40);
      } finally {
        store.close();
        db.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
