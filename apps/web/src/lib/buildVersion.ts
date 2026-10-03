import { compareVersions } from '@codefusion-cc/app-update'

/**
 * The version the website shows for itself. The website deploys with every merge, so only a build of the commit a
 * release tag names is that release; any other build is `1.2.1-dev`, the release it is on its way to.
 */
export function websiteVersion(version: string, tagsAtCommit: readonly string[]): string {
  return tagsAtCommit.includes(`v${version}`) ? version : `${version}-dev`
}

/** The release a version belongs to: `1.2.1-dev` and `1.2.1-rc.1` are both heading for `1.2.1`. */
function release(version: string): string {
  return version.replace(/^v/, '').split(/[-+]/, 1)[0] ?? version
}

/** The i18n key of what the Files pages say to a Magnetar that can't browse files. */
export type FileBrowserNotice = 'files.updateRemote' | 'files.updateNewer'

/**
 * Why the Magnetar on a device can't browse files. The browser is part of the website, so an app that is not newer than
 * the website lacks it and gets it with its next release; an app newer than the website is not behind, the page is.
 */
export function fileBrowserNotice(appVersion: string, websiteVersion: string): FileBrowserNotice {
  return compareVersions(release(appVersion), release(websiteVersion)) === 1 ? 'files.updateNewer' : 'files.updateRemote'
}
