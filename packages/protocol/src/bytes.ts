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
