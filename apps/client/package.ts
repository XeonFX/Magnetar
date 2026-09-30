/**
 * Builds the single-file Magnetar executable for one platform, with the dashboard embedded.
 *
 *   node package.ts [--target aarch64-apple-darwin] [--version 1.0.0] [--skip-web]
 *
 * Output in dist/: `Magnetar-<version>-<platform>-<arch>` (.exe on Windows). On macOS it
 * is also wrapped in Magnetar.app and zipped, which is the release asset: signed with the
 * Developer ID in MACOS_SIGNING_IDENTITY and notarized when APPLE_ID, APPLE_TEAM_ID and
 * APPLE_APP_PASSWORD are set, ad-hoc signed otherwise. On Windows the .exe is signed when
 * WINDOWS_CERTIFICATE is set.
 * The version and the release public key (release-public-key.txt) are compiled in by build.rs.
 */
import { execFileSync, execSync, type ExecFileSyncOptions } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { parseArgs } from 'node:util'

/**
 * Runs a command with its output shown; a failing command fails the build. The error names only
 * the program, not its arguments, which can hold signing passwords.
 */
function run(command: string, args: string[], options: ExecFileSyncOptions = {}): void {
  try {
    execFileSync(command, args, { stdio: 'inherit', ...options })
  } catch (e) {
    const status = (e as { status?: number | null }).status
    throw new Error(`${basename(command)} ${args[0] ?? ''} failed${status == null ? '' : ` with exit code ${status}`}`)
  }
}

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    version: { type: 'string' },
    'skip-web': { type: 'boolean', default: false },
  },
})

const root = import.meta.dirname
const repo = join(root, '..', '..')
const dist = join(root, 'dist')
const version = values.version ?? (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version: string }).version
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) throw new Error(`Invalid version ${version}`)

const hostTarget = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1]
const target = values.target ?? hostTarget
if (!target) throw new Error('Could not determine the Rust target')
const platform = target.includes('apple-darwin') ? 'macos' : target.includes('windows') ? 'windows' : 'linux'
const arch = target.startsWith('aarch64') ? 'arm64' : 'x64'
const exe = platform === 'windows' ? '.exe' : ''
const name = `Magnetar-${version}-${platform}-${arch}`

if (!values['skip-web']) {
  // Through a shell: npm is npm.cmd on Windows.
  execSync('npm run build', { cwd: join(repo, 'apps', 'web'), env: { ...process.env, VITE_APP_VERSION: version }, stdio: 'inherit' })
}
if (!existsSync(join(repo, 'apps', 'web', 'dist', 'index.html'))) throw new Error('apps/web/dist is missing; build the dashboard first')
if (!process.env.MAGNETAR_RELEASE_PUBLIC_KEY && !existsSync(join(root, 'release-public-key.txt'))) {
  console.warn('No release public key: this build will open the release page instead of installing updates')
}

run('cargo', ['build', '--release', '--locked', '--target', target, '-p', 'magnetar'], { cwd: repo, env: { ...process.env, MAGNETAR_VERSION: version } })

mkdirSync(dist, { recursive: true })
const outfile = join(dist, name + exe)
cpSync(join(repo, 'target', target, 'release', `magnetar${exe}`), outfile)
if (platform !== 'windows') chmodSync(outfile, 0o755)
console.log(`Built ${relative(process.cwd(), outfile)}`)

if (platform === 'macos') packageMacApp()
if (platform === 'windows') signWindowsExecutable(outfile)

/** Magnetar.app: a menu-bar agent (no Dock icon), ad-hoc signed, zipped with ditto. */
function packageMacApp(): void {
  const app = join(dist, 'Magnetar.app')
  rmSync(app, { recursive: true, force: true })
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true })
  cpSync(outfile, join(app, 'Contents', 'MacOS', 'Magnetar'))
  chmodSync(join(app, 'Contents', 'MacOS', 'Magnetar'), 0o755)
  cpSync(join(root, 'assets', 'AppIcon.icns'), join(app, 'Contents', 'Resources', 'AppIcon.icns'))
  const plainVersion = version.replace(/-.*/, '')
  writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Magnetar</string>
  <key>CFBundleDisplayName</key><string>Magnetar</string>
  <key>CFBundleIdentifier</key><string>cc.codefusion.magnetar</string>
  <key>CFBundleVersion</key><string>${plainVersion}</string>
  <key>CFBundleShortVersionString</key><string>${plainVersion}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Magnetar</string>
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
  // A Developer ID from the keychain when one is configured (release builds with the certificate
  // imported), otherwise ad-hoc: Gatekeeper then asks the user to confirm the first launch.
  const identity = process.env.MACOS_SIGNING_IDENTITY
  if (identity) {
    run('/usr/bin/codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, '--identifier', 'cc.codefusion.magnetar', app])
  } else {
    run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'cc.codefusion.magnetar', '--timestamp=none', app])
  }
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  const zip = join(dist, `${name}.zip`)
  const pack = () => {
    rmSync(zip, { force: true })
    run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip])
  }
  pack()
  const { APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD } = process.env
  if (identity && APPLE_ID && APPLE_TEAM_ID && APPLE_APP_PASSWORD) {
    // Apple checks the build for malware and issues a ticket; stapled, it works offline too.
    run('/usr/bin/xcrun', ['notarytool', 'submit', zip, '--apple-id', APPLE_ID, '--team-id', APPLE_TEAM_ID, '--password', APPLE_APP_PASSWORD, '--wait'])
    run('/usr/bin/xcrun', ['stapler', 'staple', app])
    run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose', app])
    pack()
    console.log('Notarized and stapled')
  }
  console.log(`Packaged ${relative(process.cwd(), zip)}`)
}

/**
 * Signs the Windows executable when a code-signing certificate is configured (WINDOWS_CERTIFICATE,
 * a base64 .pfx, and its password), so SmartScreen knows who published it.
 */
function signWindowsExecutable(file: string): void {
  const { WINDOWS_CERTIFICATE, WINDOWS_CERTIFICATE_PASSWORD } = process.env
  if (!WINDOWS_CERTIFICATE || process.platform !== 'win32') return
  const pfx = join(tmpdir(), `magnetar-signing-${process.pid}.pfx`)
  writeFileSync(pfx, Buffer.from(WINDOWS_CERTIFICATE, 'base64'))
  try {
    const kits = 'C:/Program Files (x86)/Windows Kits/10/bin'
    const versions = existsSync(kits) ? readdirSync(kits).filter(v => existsSync(join(kits, v, 'x64', 'signtool.exe'))).sort() : []
    const signtool = versions.length ? join(kits, versions.at(-1)!, 'x64', 'signtool.exe') : 'signtool'
    run(signtool, ['sign', '/f', pfx, '/p', WINDOWS_CERTIFICATE_PASSWORD ?? '', '/fd', 'sha256', '/tr', 'http://timestamp.digicert.com', '/td', 'sha256', file])
    run(signtool, ['verify', '/pa', file])
    console.log('Signed the Windows executable')
  } finally {
    rmSync(pfx, { force: true })
  }
}
