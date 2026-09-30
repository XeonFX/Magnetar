/** What a release name says about its quality, for scanning search results at a glance. */
export interface ReleaseTags {
  resolution: '4K' | '1080p' | '720p' | '480p' | null
  hdr: 'HDR' | 'DV' | null
  codec: 'HEVC' | 'H.264' | 'AV1' | null
  source: 'BluRay' | 'WEB' | 'HDTV' | 'DVD' | null
}

// Tokens are delimited by anything that isn't a letter or digit, so "x265" matches in "1080p.x265-GRP"
// but "web" doesn't match inside "webcam".
const token = (pattern: string) => new RegExp(`(?:^|[^a-z0-9])(?:${pattern})(?![a-z0-9])`, 'i')

const RESOLUTIONS: [ReleaseTags['resolution'], RegExp][] = [
  ['4K', token('2160p|4k|uhd')],
  ['1080p', token('1080[pi]')],
  ['720p', token('720p')],
  ['480p', token('480p|576p')],
]
const CODECS: [ReleaseTags['codec'], RegExp][] = [
  ['HEVC', token('x265|h\\.?265|hevc')],
  ['AV1', token('av1')],
  ['H.264', token('x264|h\\.?264|avc')],
]
const SOURCES: [ReleaseTags['source'], RegExp][] = [
  ['BluRay', token('blu-?ray|bdrip|brrip|bdremux|remux')],
  ['WEB', token('web-?dl|web-?rip|web|amzn|nf|dsnp|hmax|atvp')],
  ['HDTV', token('hdtv|pdtv')],
  ['DVD', token('dvd-?rip|dvd(?:5|9)?')],
]

function first<T>(title: string, table: [T, RegExp][]): T | null {
  return table.find(([, pattern]) => pattern.test(title))?.[0] ?? null
}

export function releaseTags(title: string): ReleaseTags {
  return {
    resolution: first(title, RESOLUTIONS),
    hdr: token('dv|dovi|dolby[ .-]?vision').test(title) ? 'DV' : token('hdr(?:10\\+?)?').test(title) ? 'HDR' : null,
    codec: first(title, CODECS),
    source: first(title, SOURCES),
  }
}
