/**
 * Drops results that don't actually match the query. Some sites (notably 1337x) match loosely
 * and, sorted by seeders, float unrelated high-seed torrents to the top — so every meaningful
 * query term must appear in the title.
 */
export function matchesQuery(query: string, title: string): boolean {
  const tokens = tokenize(query)
  if (tokens.length === 0) return true
  const normalizedTitle = normalize(title)
  return tokens.every(t => normalizedTitle.includes(t))
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function tokenize(text: string): string[] {
  return [...new Set(normalize(text).split(' ').filter(t => t.length >= 2))]
}
