// Lightweight, explainable similarity matching over historical text —
// no external ML libraries or training step. This compares a new
// description against past job/quote descriptions using word overlap
// (Jaccard similarity), so suggestions are transparent and improve
// automatically as more real jobs are logged, with no separate
// "training" process required.

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "for", "to", "of", "on", "in", "with",
  "at", "by", "from", "up", "down", "out", "off", "over", "under",
  "is", "are", "was", "were", "be", "been", "being", "this", "that",
  "service", "work", "job", "repair", "replace", "replacement", "fix",
  "check", "inspect", "inspection", "install", "installation",
]);

function tokenize(text: string): Set<string> {
  return new Set(
    (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export type MatchResult<T> = { item: T; score: number };

/**
 * Finds items whose description is similar to the query description.
 * Returns matches sorted by similarity, above a minimum relevance
 * threshold, capped to topN.
 */
export function findSimilar<T>(
  query: string,
  items: T[],
  getDescription: (item: T) => string,
  topN = 10,
  minScore = 0.12
): MatchResult<T>[] {
  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) return [];

  const scored = items
    .map((item) => ({ item, score: jaccardSimilarity(queryTokens, tokenize(getDescription(item))) }))
    .filter((m) => m.score >= minScore)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, topN);
}

export function average(nums: number[]): number {
  if (nums.length === 0) return 0;
  return Math.round((nums.reduce((s, n) => s + n, 0) / nums.length) * 100) / 100;
}
