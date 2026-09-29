/**
 * Builds the single-file MediaDownloader executable for one platform, with the dashboard embedded.
 *
 *   bun run package.ts [--target aarch64-apple-darwin] [--version 2.0.0] [--skip-web]
 *
 * Output in dist/: `MediaDownloader-<version>-<platform>-<arch>` (.exe on Windows). On macOS it
 * is also wrapped in an ad-hoc signed MediaDownloader.app and zipped, which is the release asset.
 * The version and the release public key (release-public-key.txt) are compiled in by build.rs.
 */
import { $ } from 'bun'
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    version: { type: 'string' },
    'skip-web': { type: 'boolean', default: false },
  },
})

const root = import.meta.dir
const repo = join(root, '..', '..')
const dist = join(root, 'dist')
const version = values.version ?? (await Bun.file(join(repo, 'package.json')).json()).version
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) throw new Error(`Invalid version ${version}`)

const hostTarget = (await $`rustc -vV`.text()).match(/^host: (.+)$/m)?.[1]
const target = values.target ?? hostTarget
if (!target) throw new Error('Could not determine the Rust target')
const platform = target.includes('apple-darwin') ? 'macos' : target.includes('windows') ? 'windows' : 'linux'
const arch = target.startsWith('aarch64') ? 'arm64' : 'x64'
const exe = platform === 'windows' ? '.exe' : ''
const name = `MediaDownloader-${version}-${platform}-${arch}`

if (!values['skip-web']) {
  await $`bun run build`.cwd(join(repo, 'apps', 'web')).env({ ...process.env, VITE_APP_VERSION: version })
}
if (!existsSync(join(repo, 'apps', 'web', 'dist', 'index.html'))) throw new Error('apps/web/dist is missing; build the dashboard first')
if (!process.env.MD_RELEASE_PUBLIC_KEY && !existsSync(join(root, 'release-public-key.txt'))) {
  console.warn('No release public key: this build will open the release page instead of installing updates')
}

await $`cargo build --release --locked --target ${target} -p mediadownloader`.cwd(repo).env({ ...process.env, MD_VERSION: version })

mkdirSync(dist, { recursive: true })
const outfile = join(dist, name + exe)
cpSync(join(repo, 'target', target, 'release', `mediadownloader${exe}`), outfile)
if (platform !== 'windows') chmodSync(outfile, 0o755)
console.log(`Built ${relative(process.cwd(), outfile)}`)

if (platform === 'macos') await packageMacApp()

/** MediaDownloader.app: a menu-bar agent (no Dock icon), ad-hoc signed, zipped with ditto. */
async function packageMacApp(): Promise<void> {
  const app = join(dist, 'MediaDownloader.app')
  rmSync(app, { recursive: true, force: true })
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true })
  cpSync(outfile, join(app, 'Contents', 'MacOS', 'MediaDownloader'))
  chmodSync(join(app, 'Contents', 'MacOS', 'MediaDownloader'), 0o755)
  cpSync(join(root, 'assets', 'AppIcon.icns'), join(app, 'Contents', 'Resources', 'AppIcon.icns'))
  const plainVersion = version.replace(/-.*/, '')
  writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>MediaDownloader</string>
  <key>CFBundleDisplayName</key><string>MediaDownloader</string>
  <key>CFBundleIdentifier</key><string>cc.codefusion.mediadownloader</string>
  <key>CFBundleVersion</key><string>${plainVersion}</string>
  <key>CFBundleShortVersionString</key><string>${plainVersion}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>MediaDownloader</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>Magnet link</string>
      <key>CFBundleURLSchemes</key><array><string>magnet</string></array>
    </dict>
  </array>
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key><string>Torrent file</string>
      <key>CFBundleTypeRole</key><string>Viewer</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>org.bittorrent.torrent</string></array>
    </dict>
  </array>
  <key>UTImportedTypeDeclarations</key>
  <array>
    <dict>
      <key>UTTypeIdentifier</key><string>org.bittorrent.torrent</string>
      <key>UTTypeDescription</key><string>BitTorrent file</string>
      <key>UTTypeConformsTo</key><array><string>public.data</string></array>
      <key>UTTypeTagSpecification</key>
      <dict>
        <key>public.filename-extension</key><array><string>torrent</string></array>
        <key>public.mime-type</key><array><string>application/x-bittorrent</string></array>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`)
  if (process.platform !== 'darwin') {
    console.warn('Skipping signing and zipping: macOS bundles must be signed on macOS')
    return
  }
  await $`/usr/bin/codesign --force --sign - --identifier cc.codefusion.mediadownloader --timestamp=none ${app}`
  await $`/usr/bin/codesign --verify --deep --strict --verbose=2 ${app}`
  const zip = join(dist, `${name}.zip`)
  rmSync(zip, { force: true })
  await $`/usr/bin/ditto -c -k --keepParent ${app} ${zip}`
  console.log(`Packaged ${relative(process.cwd(), zip)}`)
}
