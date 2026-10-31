import type { ProjectEvent } from "../../shared/agents";
export function parseEventFrames(input: string, after: number) {
  const frames = input.replace(/\r\n/g, "\n").split("\n\n");
  const rest = frames.pop() || "",
    events: ProjectEvent[] = [];
  let cursor = after;
  for (const frame of frames) {
    const data = frame
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    const event = JSON.parse(data) as ProjectEvent;
    if (Number.isSafeInteger(event.id) && event.id > cursor) {
      events.push(event);
      cursor = event.id;
    }
  }
  return { events, rest, cursor };
}
