import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { scrub } from './scrub.ts'
import vector from './scrub-vector.json'

describe('scrub', () => {
  // The Rust scrubber (apps/client/src/protocol/scrub.rs) is held to the same cases.
  test.each(vector.cases)('$input', ({ input, output }) => {
    expect(scrub(input)).toBe(output)
  })

  test('leaves no part of a path, its file name least of all', () => {
    const part = fc.stringMatching(/^[A-Za-z0-9._[\] -]{0,23}[A-Za-z0-9._[\]-]$/)
    const start = fc.oneof(fc.constantFrom('', 'C:', 'd:'), fc.stringMatching(/^[A-Za-z0-9._-]{1,12}$/))
    fc.assert(fc.property(start, fc.constantFrom('/', '\\'), fc.array(part, { minLength: 1, maxLength: 5 }), (first, separator, parts) => {
      expect(scrub(`could not open ${first}${separator}${parts.join(separator)}: denied`)).toBe('could not open <path>: denied')
    }))
  })
})
