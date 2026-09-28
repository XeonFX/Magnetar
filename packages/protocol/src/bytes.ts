const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']

/** Formats a byte count as a binary size, e.g. "1.4 GiB". */
export function formatBytes(bytes: number, decimals = 1): string {
  let size = Math.max(0, bytes)
  let unit = 0
  while (size >= 1024 && unit < UNITS.length - 1) {
    size /= 1024
    unit++
  }
  const factor = 10 ** decimals
  return `${Math.round(size * factor) / factor} ${UNITS[unit]}`
}

/** Formats a per-second rate, e.g. "2.3 MiB/s". */
export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}

const MULTIPLIERS: Record<string, number> = {
  KIB: 1024, KB: 1024,
  MIB: 1024 ** 2, MB: 1024 ** 2,
  GIB: 1024 ** 3, GB: 1024 ** 3,
  TIB: 1024 ** 4, TB: 1024 ** 4,
}

/** Parses "1.4 GiB" or "550.3 MB" into bytes; 0 when unparseable. Sites use binary units under both spellings. */
export function parseBytes(text: string | null | undefined): number {
  if (!text) return 0
  const parts = text.replaceAll(' ', ' ').trim().split(/\s+/)
  if (parts.length < 2) return 0
  const value = Number.parseFloat(parts[0]!)
  if (!Number.isFinite(value)) return 0
  return Math.trunc(value * (MULTIPLIERS[parts[1]!.toUpperCase()] ?? 1))
}
