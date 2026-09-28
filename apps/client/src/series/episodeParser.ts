/**
 * Extracts (season, episode) from a torrent title. Understands "S01E05", "1x05", "Episode 5",
 * "Ep05", "E05" and anime-style "Show - 05".
 */
export function parseEpisode(title: string): { season: number | null; episode: number } | null {
  if (!title.trim()) return null

  let m = /[Ss](\d{1,2})[\s._-]*[Ee](\d{1,4})/.exec(title)
  if (m) return { season: Number(m[1]), episode: Number(m[2]) }

  m = /\b(\d{1,2})x(\d{2,4})\b/.exec(title)
  if (m) return { season: Number(m[1]), episode: Number(m[2]) }

  m = /\b(?:[Ee]p(?:isode)?|[Ee])[\s._]?(\d{1,4})\b/.exec(title)
  if (m) return { season: null, episode: Number(m[1]) }

  // "Show Name - 05 [1080p]", without mistaking years or resolutions for episodes.
  m = /[-–]\s*(\d{1,4})(?![\dpPxX])/.exec(title)
  if (m) {
    const value = Number(m[1])
    if (value > 0 && value < 1900) return { season: null, episode: value }
  }
  return null
}

export interface EpisodeRule {
  query: string
  titleFilter: string | null
  season: number | null
}

/** Whether a result title is the wanted episode of this rule. */
export function matchesEpisode(title: string, rule: EpisodeRule, wantedEpisode: number): boolean {
  const lower = title.toLowerCase()
  const required = [...rule.query.split(' '), ...(rule.titleFilter ?? '').split(' ')].filter(Boolean)
  if (!required.every(token => lower.includes(token.toLowerCase()))) return false
  const parsed = parseEpisode(title)
  if (!parsed || parsed.episode !== wantedEpisode) return false
  if (rule.season !== null) {
    // A season is required, so a title without one can't be trusted to be the right season.
    if (parsed.season === null || parsed.season !== rule.season) return false
  }
  return true
}

/** Queries to try for one episode: targeted first, then broader. */
export function episodeQueries(rule: EpisodeRule, episode: number): string[] {
  const pad = (n: number) => String(n).padStart(2, '0')
  const queries: string[] = []
  if (rule.season !== null) queries.push(`${rule.query} S${pad(rule.season)}E${pad(episode)}`)
  queries.push(`${rule.query} ${pad(episode)}`, rule.query)
  return [...new Set(queries)]
}
