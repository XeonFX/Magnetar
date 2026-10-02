/**
 * Device names are the first part of a device's address on the website (`/MacBook-Pro/search/dragon`), so they
 * hold only what a URL shows as it is: ASCII letters and digits, joined by single hyphens, at most 40 characters,
 * none of the website's own top-level paths, and unique per account regardless of case. The rules and their
 * test cases live in device-names.json, which the app's Rust side reads too.
 */
import rules from './device-names.json'

export const DEVICE_NAME_MAX_LENGTH: number = rules.maxLength

const RESERVED = new Set(rules.reserved)
const SHAPE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/
/** Letters that Unicode does not decompose into an ASCII letter and a mark. */
const SPELLED_OUT: Record<string, string> = { ß: 'ss', ł: 'l', Ł: 'L', ø: 'o', Ø: 'O', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', đ: 'd', Đ: 'D', þ: 'th', Þ: 'Th' }
const FALLBACK = 'Magnetar'

/** Whether `name` may be a device's name as it is. */
export function isDeviceName(name: string): boolean {
  return name.length <= DEVICE_NAME_MAX_LENGTH && SHAPE.test(name) && !RESERVED.has(name.toLowerCase())
}

/** Whether two names are the same name in an address, which ignores case. */
export function sameDeviceName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * The closest valid name to any text: accents dropped (`Paweł's Mac` → `Pawels-Mac`), every run of other
 * characters a hyphen, cut to the length limit. A reserved word gets `-device` after it; nothing usable left
 * gives `Magnetar`.
 */
export function toDeviceName(text: string): string {
  const name = spell(text)
  if (!name) return FALLBACK
  return RESERVED.has(name.toLowerCase()) ? `${name}-device` : name
}

/**
 * The website's own word `text` spells (`Docs`, ` pricing `), which a device can't be named, or null. For saying so
 * as someone types, before `toDeviceName` adds `-device`.
 */
export function reservedDeviceName(text: string): string | null {
  const name = spell(text)
  return name && RESERVED.has(name.toLowerCase()) ? name : null
}

/** `text` in the letters an address shows, at most as long as a name, or empty. */
function spell(text: string): string {
  const ascii = text.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[ßłŁøØæÆœŒđĐþÞ]/g, char => SPELLED_OUT[char]!)
  return cut(ascii.replace(/['’]/g, '').replace(/[^A-Za-z0-9]+/g, '-'), DEVICE_NAME_MAX_LENGTH)
}

/**
 * `name` if no device in `taken` has it (in any case), else the first free `name-2`, `name-3`… within the
 * length limit. `name` must be valid (`isDeviceName`).
 */
export function uniqueDeviceName(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map(n => n.toLowerCase()))
  if (!used.has(name.toLowerCase())) return name
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const candidate = cut(name, DEVICE_NAME_MAX_LENGTH - suffix.length) + suffix
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}

/** At most `length` characters, without hyphens at either end. */
function cut(name: string, length: number): string {
  return name.replace(/^-+/, '').slice(0, length).replace(/-+$/, '')
}
