import { describe, expect, it } from 'vitest'
import { fileBrowserNotice, websiteVersion } from './buildVersion.ts'

describe('websiteVersion', () => {
  it('is the release on the commit its tag names', () => {
    expect(websiteVersion('1.2.1', ['v1.2.1'])).toBe('1.2.1')
    expect(websiteVersion('1.2.1', ['nightly', 'v1.2.1'])).toBe('1.2.1')
  })

  it('is a development build on any other commit', () => {
    expect(websiteVersion('1.2.1', [])).toBe('1.2.1-dev')
    expect(websiteVersion('1.2.1', ['v1.2.0'])).toBe('1.2.1-dev')
    expect(websiteVersion('1.2.1', ['v1.2.1-rc.1'])).toBe('1.2.1-dev')
  })
})

describe('fileBrowserNotice', () => {
  it('says the next release brings browsing to the same version missing it', () => {
    expect(fileBrowserNotice('1.2.1', '1.2.1')).toBe('files.updateRemote')
    expect(fileBrowserNotice('1.2.1', '1.2.1-dev')).toBe('files.updateRemote')
  })

  it('says it too to an older app', () => {
    expect(fileBrowserNotice('1.2.0', '1.2.1-dev')).toBe('files.updateRemote')
    expect(fileBrowserNotice('1.1.9', '1.2.1')).toBe('files.updateRemote')
  })

  it('does not call a newer app behind', () => {
    expect(fileBrowserNotice('1.3.0', '1.2.1-dev')).toBe('files.updateNewer')
    expect(fileBrowserNotice('1.2.2', '1.2.1')).toBe('files.updateNewer')
  })

  it('treats a version it cannot read as the app missing the feature', () => {
    expect(fileBrowserNotice('', '1.2.1-dev')).toBe('files.updateRemote')
    expect(fileBrowserNotice('1.2.0', 'dev')).toBe('files.updateRemote')
  })
})
