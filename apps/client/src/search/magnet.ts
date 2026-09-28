/**
 * A broad set of well-known public trackers. Providers rebuild magnets with these rather than
 * trusting the tracker list served by a (possibly untrusted) mirror.
 */
export const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.dler.org:6969/announce',
]

export function buildMagnet(infoHash: string, name: string, trackers: readonly string[] = DEFAULT_TRACKERS): string {
  const tr = trackers.map(t => `&tr=${encodeURIComponent(t)}`).join('')
  return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}${tr}`
}

export function extractInfoHash(magnetUri: string): string | null {
  return /xt=urn:btih:([0-9A-Za-z]+)/i.exec(magnetUri)?.[1] ?? null
}

/** The `dn` display name of a magnet, if it has one. */
export function magnetName(magnetUri: string): string | null {
  try {
    const query = magnetUri.slice(magnetUri.indexOf('?') + 1)
    return new URLSearchParams(query).get('dn')
  } catch {
    return null
  }
}

/** Normalises a btih to 40-char lowercase hex; base32 v1 hashes are converted. Null if invalid. */
export function normalizeInfoHash(hash: string): string | null {
  if (/^[0-9a-f]{40}$/i.test(hash) || /^[0-9a-f]{64}$/i.test(hash)) return hash.toLowerCase()
  if (/^[A-Z2-7]{32}$/i.test(hash)) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    let bits = ''
    for (const char of hash.toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, '0')
    let hex = ''
    for (let i = 0; i + 4 <= bits.length; i += 4) hex += Number.parseInt(bits.slice(i, i + 4), 2).toString(16)
    return hex
  }
  return null
}
