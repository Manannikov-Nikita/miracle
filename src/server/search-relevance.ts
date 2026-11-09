import {
  findSearchMatch,
  normalizeSearchText,
  type SearchTextMatch,
} from "../shared/workspace-search.js";

const STOP_WORDS = new Set(
  "и или а но за по в во на с со к ко из от до для о об обо у над под при про the a an of for in on at to and or by with from".split(
    " ",
  ),
);
const words = () => /[\p{L}\p{N}\p{M}]+/gu;
const fold = (text: string) => normalizeSearchText(text).replace(/ё/g, "е");

// Light inflection matching, not a dictionary: keep a substantial Russian stem
// and leave SQL identifiers, numbers and other languages unchanged.
function stem(word: string) {
  if (!/^[а-я]{4,}$/.test(word)) return word;
  const root = word.replace(
    /(?:иями|ями|ами|ого|его|ому|ему|ыми|ими|ая|яя|ое|ее|ые|ие|ый|ий|ой|ых|их|ов|ев|ам|ям|ах|ях|ом|ем|ою|ею|ия|ии|ию|ей|а|я|ы|и|у|ю|е|о|ь)$/,
    "",
  );
  return root.length >= 3 ? root : word;
}

export function prepareSearchQuery(query: string) {
  const terms = new Map<string, string>();
  for (const [word] of fold(query).matchAll(words())) {
    if (!STOP_WORDS.has(word)) terms.set(stem(word), word);
  }
  return { query, terms: [...terms].map(([root, word]) => ({ root, word })) };
}
export type PreparedSearchQuery = ReturnType<typeof prepareSearchQuery>;
export type RelevantMatch = {
  match: SearchTextMatch;
  coverage: number;
  phrase: boolean;
};

export function findRelevantMatch(
  text: string,
  { query, terms }: PreparedSearchQuery,
): RelevantMatch | undefined {
  const phrase = findSearchMatch(text, query);
  if (phrase)
    return { match: phrase, coverage: Math.max(1, terms.length), phrase: true };
  if (!terms.length) return;

  const found = new Set<number>();
  const nearby = new Map<number, number>();
  const window: { start: number; end: number; terms: number[] }[] = [];
  let best: { start: number; end: number; count: number } | undefined;
  for (const token of text.matchAll(words())) {
    const value = fold(token[0]);
    const root = stem(value);
    const hits: number[] = [];
    let end = token.index;
    terms.forEach((term, index) => {
      if (
        value === term.word ||
        value.startsWith(term.word) ||
        root === term.root
      ) {
        hits.push(index);
        found.add(index);
        const length =
          value === term.word || root === term.root
            ? token[0].length
            : (findSearchMatch(token[0], term.word)?.end ?? term.word.length);
        end = Math.max(end, token.index + length);
      }
    });
    if (!hits.length) continue;
    window.push({ start: token.index, end, terms: hits });
    for (const index of hits) nearby.set(index, (nearby.get(index) ?? 0) + 1);
    while (
      window.length > 1 &&
      (end - window[0].start > 160 ||
        window[0].terms.every((index) => nearby.get(index)! > 1))
    ) {
      for (const index of window.shift()!.terms) {
        const count = nearby.get(index)! - 1;
        if (count) nearby.set(index, count);
        else nearby.delete(index);
      }
    }
    // Prefer the excerpt containing the most query words, then the tightest
    // original-text range. Memory stays bounded even for a 2 MiB text file.
    const start = window[0].start;
    if (
      !best ||
      nearby.size > best.count ||
      (nearby.size === best.count && end - start < best.end - best.start)
    ) {
      best = { start, end, count: nearby.size };
    }
  }
  if (!best) return;
  const { start, end } = best;
  return {
    coverage: found.size,
    phrase: false,
    match: {
      start,
      end,
      text: text.slice(start, end),
      before: text.slice(Math.max(0, start - 32), start),
      after: text.slice(end, end + 32),
    },
  };
}
