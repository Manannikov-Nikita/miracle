import { describe, expect, it } from "vitest";
import { ProjectSync } from "../src/client/agents/ProjectSync";
import type { AgentTargetContext } from "../src/shared/agents";

describe("agent target context", () => {
  it("publishes the current selection when blocks change and clears it on unmount", () => {
    const project = new ProjectSync();
    const seen: AgentTargetContext[] = [];
    const unsubscribe = project.subscribeContext((context) =>
      seen.push(context),
    );
    let nodes = [{ id: "chart-a", title: "Revenue" }];
    const unregister = project.register("board", {
      context: () => ({ boardId: "board-a", boardNodes: nodes }),
      flush: async () => {},
    });
    expect(seen.at(-1)).toEqual({ boardId: "board-a", boardNodes: nodes });
    nodes = [{ id: "chart-b", title: "Trips" }];
    project.contextChanged();
    expect(seen.at(-1)?.boardNodes).toEqual(nodes);
    unregister();
    expect(seen.at(-1)).toEqual({});
    unsubscribe();
  });

  it("freezes selected blocks and file references before asynchronous saves", async () => {
    const project = new ProjectSync();
    const nodes = [{ id: "chart-a", title: "Revenue" }];
    const files = ["sql/monthly trips.sql"];
    let finish!: () => void;
    project.register("board", {
      context: () => ({ boardId: "board-a", boardNodes: nodes }),
      flush: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    const pending = project.prepare({ filePaths: files });
    nodes[0].id = "chart-b";
    nodes[0].title = "Other chart";
    files.push("another.sql");
    finish();
    expect(await pending).toEqual({
      boardId: "board-a",
      boardNodes: [{ id: "chart-a", title: "Revenue" }],
      filePaths: ["sql/monthly trips.sql"],
    });
  });

  it("omits an explicitly dismissed block even though it is still selected on the board", async () => {
    const project = new ProjectSync();
    project.register("board", {
      context: () => ({
        boardId: "board",
        boardNodes: [{ id: "chart", title: "Revenue" }],
      }),
      flush: async () => {},
    });
    expect(await project.prepare({ boardNodes: [] })).toEqual({
      boardId: "board",
      boardNodes: [],
    });
  });
});
