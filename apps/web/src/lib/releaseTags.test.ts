import { describe, expect, test } from 'vitest'
import { releaseTags } from './releaseTags.ts'

describe('releaseTags', () => {
  test('reads resolution, HDR, codec and source from scene names', () => {
    expect(releaseTags('The.Expanse.S03E07.2160p.AMZN.WEB-DL.DDP5.1.HDR.HEVC-GROUP')).toEqual({
      resolution: '4K', hdr: 'HDR', codec: 'HEVC', source: 'WEB',
    })
    expect(releaseTags('Big Buck Bunny (2008) 720p Bluray nHD x264-NhaNc3')).toEqual({
      resolution: '720p', hdr: null, codec: 'H.264', source: 'BluRay',
    })
    expect(releaseTags('Show - 05 [1080p][DV][x265]')).toMatchObject({ resolution: '1080p', hdr: 'DV', codec: 'HEVC' })
  })

  test('ignores look-alikes inside other words', () => {
    expect(releaseTags('Webcam Tutorial Collection')).toEqual({ resolution: null, hdr: null, codec: null, source: null })
    expect(releaseTags('big-buck-bunny-NTSC.iso')).toEqual({ resolution: null, hdr: null, codec: null, source: null })
  })
})
