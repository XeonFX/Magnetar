import { describe, expect, test } from 'bun:test'
import { fromBase64, srtToVtt } from './streaming.ts'

describe('subtitles', () => {
  test('SubRip becomes WebVTT with dotted milliseconds, whatever the line endings', () => {
    const srt = '﻿1\r\n00:00:01,500 --> 00:00:03,250\r\nHello, world\r\n\r\n2\r\n01:02:03,004 --> 01:02:04,000\r\nBye\r\n'
    expect(srtToVtt(srt)).toBe('WEBVTT\n\n1\n00:00:01.500 --> 00:00:03.250\nHello, world\n\n2\n01:02:03.004 --> 01:02:04.000\nBye\n')
  })

  test('commas in the text itself are left alone', () => {
    expect(srtToVtt('1\n00:00:01,000 --> 00:00:02,000\nWait, 12:34:56,789 is a time')).toContain('Wait, 12:34:56,789 is a time')
  })
})

describe('base64', () => {
  test('decodes every byte value, and nothing', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect([...fromBase64(Buffer.from(all).toString('base64'))]).toEqual([...all])
    expect(fromBase64('').length).toBe(0)
  })
})
