import { describe, expect, it } from "vitest";
import { ProjectSync } from "../src/client/agents/ProjectSync";
import type { AgentEntityWork } from "../src/shared/agent-work";
import type { ProjectEvent } from "../src/shared/agents";

const work: AgentEntityWork = {
  target: { kind: "editor", id: "doc" },
  turnId: "turn",
  chatId: "chat",
  startedAt: "now",
};
const event = (id: number, locks: AgentEntityWork[]) =>
  ({ id, type: "agent.work", data: { locks } }) as ProjectEvent;

describe("project agent work registry", () => {
  it("retains the last valid snapshot when hydration returns malformed data", () => {
    const project = new ProjectSync();
    project.emit(event(4, [work]));
    project.receiveWorkSnapshot([] as never);
    expect(project.workSnapshot()).toEqual({ revision: 4, locks: [work] });
  });
  it("ignores an older HTTP snapshot after a newer work event", () => {
    const project = new ProjectSync();
    project.emit(event(4, [work]));
    project.receiveWorkSnapshot({ revision: 3, locks: [] });
    expect(project.workSnapshot()).toEqual({ revision: 4, locks: [work] });
    project.emit(event(5, []));
    project.receiveWorkSnapshot({ revision: 4, locks: [work] });
    expect(project.workSnapshot()).toEqual({ revision: 5, locks: [] });
  });
  it("publishes accepted snapshots once and hydrates release on reconnect", async () => {
    let resolve!: (value: {
      revision: number;
      locks: AgentEntityWork[];
    }) => void;
    const project = new ProjectSync(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const seen: number[] = [];
    project.subscribeWork((snapshot) => seen.push(snapshot.locks.length));
    project.emit(event(4, [work]));
    project.emit(event(4, [work]));
    const loading = project.hydrateWork();
    project.emit(event(6, []));
    resolve({ revision: 5, locks: [work] });
    await loading;
    expect(seen).toEqual([1, 0]);
    expect(project.workSnapshot().revision).toBe(6);
  });
});
