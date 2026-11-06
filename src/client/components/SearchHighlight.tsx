import type { ReactNode } from "react";

type Match = { start: number; end: number };
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function matchRanges(text: string, query: string): Match[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const folded = text.toLocaleLowerCase();
  let index = folded.indexOf(needle);
  if (index < 0) return [];

  // Lowercasing can change UTF-16 length (İ → i + combining dot).
  // Keep the original ranges so matching never changes or splits the label.
  const originals: Match[] = [];
  for (const { segment, index: start } of graphemes.segment(text)) {
    const range = { start, end: start + segment.length };
    for (let unit = 0; unit < segment.toLocaleLowerCase().length; unit++)
      originals.push(range);
  }
  const matches: Match[] = [];
  while (index >= 0) {
    const range = {
      start: originals[index].start,
      end: originals[index + needle.length - 1].end,
    };
    const previous = matches.at(-1);
    if (previous && range.start < previous.end)
      previous.end = Math.max(previous.end, range.end);
    else matches.push(range);
    index = folded.indexOf(needle, index + needle.length);
  }
  return matches;
}

export default function SearchHighlight({
  text,
  query,
  searchText = text,
  textOffset = 0,
}: {
  text: string;
  query: string;
  searchText?: string;
  textOffset?: number;
}) {
  const matches = matchRanges(searchText, query)
    .map(({ start, end }) => ({
      start: Math.max(0, start - textOffset),
      end: Math.min(text.length, end - textOffset),
    }))
    .filter(({ start, end }) => start < end);
  if (!matches.length) return text;
  const content: ReactNode[] = [];
  let offset = 0;
  for (const { start, end } of matches) {
    if (start > offset) content.push(text.slice(offset, start));
    content.push(
      <mark className="explorer-search-match" key={start}>
        {text.slice(start, end)}
      </mark>,
    );
    offset = end;
  }
  if (offset < text.length) content.push(text.slice(offset));
  return content;
}
