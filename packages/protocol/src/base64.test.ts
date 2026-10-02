import { describe, expect, test } from 'vitest'
import { fromBase64, toBase64 } from './base64.ts'

const sample = (size: number) => Uint8Array.from({ length: size }, (_, i) => (i * 131 + size) & 255)

describe('base64', () => {
  test('encodes like the standard for every length around the 3-byte groups, and large inputs', () => {
    for (const size of [0, 1, 2, 3, 4, 5, 32_767, 32_768, 32_769, 700_001]) {
      expect(toBase64(sample(size)), String(size)).toBe(Buffer.from(sample(size)).toString('base64'))
    }
  })

  test('decodes every byte value, and nothing', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect([...fromBase64(Buffer.from(all).toString('base64'))]).toEqual([...all])
    expect(fromBase64('').length).toBe(0)
  })

  test('round-trips', () => {
    for (const size of [1, 2, 3, 100_003]) expect([...fromBase64(toBase64(sample(size)))]).toEqual([...sample(size)])
  })
})
