import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { DEVICE_NAME_MAX_LENGTH, isDeviceName, sameDeviceName, toDeviceName, uniqueDeviceName } from './deviceName.ts'
import rules from './device-names.json'

describe('device names', () => {
  test('accept the shared valid cases and refuse the invalid ones', () => {
    for (const name of rules.valid) expect(isDeviceName(name), name).toBe(true)
    for (const name of rules.invalid) expect(isDeviceName(name), JSON.stringify(name)).toBe(false)
  })

  test('refuse every top-level path of the website, in any case', () => {
    for (const path of ['login', 'pair', 'link', 'add', 'd', 'api', 'assets']) {
      expect(isDeviceName(path)).toBe(false)
      expect(isDeviceName(path.toUpperCase())).toBe(false)
    }
  })

  test('compare without case', () => {
    expect(sameDeviceName('MacBook-Pro', 'macbook-pro')).toBe(true)
    expect(sameDeviceName('MacBook-Pro', 'MacBook-Pro-2')).toBe(false)
  })
})

describe('turning text into a name', () => {
  test('keeps hostnames as they are and joins words with hyphens', () => {
    expect(toDeviceName('MacBook-Pro')).toBe('MacBook-Pro')
    expect(toDeviceName('Studio Mac')).toBe('Studio-Mac')
    expect(toDeviceName("Krystian's MacBook Pro")).toBe('Krystians-MacBook-Pro')
    expect(toDeviceName('  living room / NAS  ')).toBe('living-room-NAS')
    expect(toDeviceName('mini.local')).toBe('mini-local')
  })

  test('spells accented and special letters in ASCII', () => {
    expect(toDeviceName('Pawłów')).toBe('Pawlow')
    expect(toDeviceName('Zażółć gęślą jaźń')).toBe('Zazolc-gesla-jazn')
    expect(toDeviceName('Straße')).toBe('Strasse')
    expect(toDeviceName('Ærø Café')).toBe('AEro-Cafe')
  })

  test('falls back when nothing usable is left, and steps around reserved words', () => {
    expect(toDeviceName('')).toBe('Magnetar')
    expect(toDeviceName('---')).toBe('Magnetar')
    expect(toDeviceName('电脑')).toBe('Magnetar')
    expect(toDeviceName('😀')).toBe('Magnetar')
    expect(toDeviceName('Login')).toBe('Login-device')
    expect(toDeviceName('d')).toBe('d-device')
  })

  test('cuts long text without leaving a hyphen at the end', () => {
    expect(toDeviceName('a'.repeat(39) + ' b')).toBe('a'.repeat(39))
    expect(toDeviceName('x'.repeat(100))).toBe('x'.repeat(DEVICE_NAME_MAX_LENGTH))
  })

  test('always gives a valid name, and leaves a valid one alone', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 80 }), text => {
      const name = toDeviceName(text)
      expect(isDeviceName(name)).toBe(true)
      expect(toDeviceName(name)).toBe(name)
    }))
  })
})

describe('a name no other device has', () => {
  test('is the name itself when free', () => {
    expect(uniqueDeviceName('MacBook-Pro', [])).toBe('MacBook-Pro')
    expect(uniqueDeviceName('MacBook-Pro', ['Studio-Mac', 'MacBook-Pro-2'])).toBe('MacBook-Pro')
  })

  test('counts up past names taken in any case', () => {
    expect(uniqueDeviceName('MacBook-Pro', ['macbook-pro'])).toBe('MacBook-Pro-2')
    expect(uniqueDeviceName('MacBook-Pro', ['MacBook-Pro', 'MACBOOK-PRO-2', 'MacBook-Pro-3'])).toBe('MacBook-Pro-4')
  })

  test('stays within the length limit', () => {
    const long = 'a'.repeat(DEVICE_NAME_MAX_LENGTH)
    expect(uniqueDeviceName(long, [long])).toBe(`${'a'.repeat(DEVICE_NAME_MAX_LENGTH - 2)}-2`)
    // A cut that lands on a hyphen drops it rather than doubling it.
    const hyphenated = `${'a'.repeat(37)}-bc`
    expect(uniqueDeviceName(hyphenated, [hyphenated])).toBe(`${'a'.repeat(37)}-2`)
  })

  test('is always valid and free', () => {
    const names = fc.string({ unit: 'binary', maxLength: 60 }).map(toDeviceName)
    fc.assert(fc.property(names, fc.array(names, { maxLength: 30 }), (name, taken) => {
      const unique = uniqueDeviceName(name, [...taken, name])
      expect(isDeviceName(unique)).toBe(true)
      expect([...taken, name].some(t => sameDeviceName(t, unique))).toBe(false)
    }))
  })
})
