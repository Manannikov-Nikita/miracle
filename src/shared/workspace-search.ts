export const SEARCH_GROUPS = [
  "boards",
  "presentations",
  "sql",
  "markdown",
  "files",
] as const;
export type SearchGroupKey = (typeof SEARCH_GROUPS)[number];

/** Offsets address the original text, in UTF-16 units (as used by both editors). */
export interface SearchTextMatch {
  start: number;
  end: number;
  text: string;
  before: string;
  after: string;
}
export type SearchTarget =
  | { kind: "file"; path: string; revision: string; match?: SearchTextMatch }
  | { kind: "query"; id: string; revision: number; match?: SearchTextMatch }
  | {
      kind: "board" | "presentation";
      id: string;
      revision: number;
      nodeId?: string;
      edgeId?: string;
      slideId?: string;
      field?: string;
      match?: SearchTextMatch;
    };
export interface SearchResult {
  key: string;
  group: SearchGroupKey;
  title: string;
  subtitle: string;
  /** Comparable across types within one search response; higher is better. */
  relevance?: number;
  snippet?: { text: string; start: number; end: number };
  target: SearchTarget;
}
export type TextSearchNavigationRequest = {
  requestId: string;
  target: Extract<SearchTarget, { kind: "file" | "query" }>;
};
export type TextSearchRevealRequest = {
  requestId: string;
  match?: SearchTextMatch;
};
export interface SearchResponse {
  query: string;
  groups: { type: SearchGroupKey; total: number; items: SearchResult[] }[];
  incomplete: boolean;
}

export const normalizeSearchText = (text: string) =>
  text.normalize("NFC").toLowerCase();

export function findSearchMatch(
  text: string,
  query: string,
): SearchTextMatch | undefined {
  const needle = normalizeSearchText(query);
  if (!needle) return;
  const normalized = text.normalize("NFC");
  const folded = normalized.toLowerCase();
  const index = folded.indexOf(needle);
  if (index < 0) return;
  let start = index;
  let end = index + needle.length;
  if (normalized !== text || folded.length !== text.length) {
    // Canonical composition and case folding may change offsets. Map only the
    // found range, without retaining a second per-character copy of a file.
    const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let offset = 0;
    let mappedStart = false;
    for (const part of segments.segment(text)) {
      const next = offset + normalizeSearchText(part.segment).length;
      if (!mappedStart && index < next) {
        start = part.index;
        mappedStart = true;
      }
      if (index + needle.length <= next) {
        end = part.index + part.segment.length;
        break;
      }
      offset = next;
    }
  }
  return {
    start,
    end,
    text: text.slice(start, end),
    before: text.slice(Math.max(0, start - 32), start),
    after: text.slice(end, end + 32),
  };
}

export function searchSnippet(text: string, match: SearchTextMatch) {
  const from = Math.max(0, match.start - 64);
  const to = Math.min(text.length, match.end + 100);
  const prefix = from ? "…" : "";
  return {
    text:
      prefix +
      text.slice(from, to).replace(/[\r\n\t]/g, " ") +
      (to < text.length ? "…" : ""),
    start: prefix.length + match.start - from,
    end: prefix.length + match.end - from,
  };
}

/** Never move a cursor using an unchecked stale line number. */
export function resolveSearchMatch(
  text: string,
  match: SearchTextMatch,
): { start: number; end: number } | undefined {
  if (!match.text) return;
  const anchored = (start: number) =>
    text.slice(Math.max(0, start - match.before.length), start) ===
      match.before &&
    text.slice(
      start + match.text.length,
      start + match.text.length + match.after.length,
    ) === match.after;
  if (
    match.start >= 0 &&
    match.end === match.start + match.text.length &&
    text.slice(match.start, match.end) === match.text &&
    anchored(match.start)
  )
    return { start: match.start, end: match.end };
  let candidate: number | undefined;
  let anchor: number | undefined;
  let candidates = 0;
  let anchors = 0;
  let offset = 0;
  while (offset <= text.length) {
    const found = text.indexOf(match.text, offset);
    if (found < 0) break;
    candidate = found;
    candidates++;
    if (anchored(found)) {
      anchor = found;
      anchors++;
    }
    offset = found + 1;
  }
  const start =
    anchors === 1 ? anchor : candidates === 1 ? candidate : undefined;
  return start === undefined
    ? undefined
    : { start, end: start + match.text.length };
}
