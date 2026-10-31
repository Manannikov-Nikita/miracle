import { describe, it, expect } from "vitest";
import { parseEventFrames } from "../src/client/agents/events";
describe("project event stream", () => {
  it("buffers split frames, ignores comments and deduplicates replayed IDs", () => {
    const first = parseEventFrames(
      ': keepalive\n\nid: 1\ndata: {"id":1,"type":"chat.updated","data":{}}\n\nid: 2\ndata: {"id":2,',
      0,
    );
    expect(first.events.map((e) => e.id)).toEqual([1]);
    const next = parseEventFrames(
      first.rest +
        '"type":"editor.updated","data":{}}\n\nid: 2\ndata: {"id":2,"type":"editor.updated","data":{}}\n\n',
      first.cursor,
    );
    expect(next.events.map((e) => e.id)).toEqual([2]);
    expect(next.rest).toBe("");
  });
});
