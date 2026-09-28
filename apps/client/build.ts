/**
 * Builds the single-file MediaDownloader executable for one platform, with the dashboard embedded.
 *
 *   bun run build.ts [--target bun-darwin-arm64] [--version 2.0.0] [--skip-web]
 *
 * Output in dist/: `MediaDownloader-<version>-<platform>-<arch>` (.exe on Windows). On macOS it
 * is also wrapped in an ad-hoc signed MediaDownloader.app and zipped, which is the release asset.
 * The release public key (release-public-key.txt) is compiled in so the updater can verify releases.
 */
import { $ } from 'bun'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import { stubWebrtc } from './stub-webrtc.ts'

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    version: { type: 'string' },
    'skip-web': { type: 'boolean', default: false },
  },
})

const root = import.meta.dir
const webDist = join(root, '..', 'web', 'dist')
const dist = join(root, 'dist')
const version = values.version ?? (await Bun.file(join(root, '..', '..', 'package.json')).json()).version
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) throw new Error(`Invalid version ${version}`)

const hostTarget = `bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`
const target = (values.target ?? hostTarget) as Bun.Build.CompileTarget
const [, os, arch] = target.split('-') as [string, 'darwin' | 'linux' | 'windows', 'arm64' | 'x64']
const platform = os === 'darwin' ? 'macos' : os
const exe = os === 'windows' ? '.exe' : ''
const name = `MediaDownloader-${version}-${platform}-${arch}`

if (!values['skip-web']) {
  await $`bun run build`.cwd(join(root, '..', 'web')).env({ ...process.env, VITE_APP_VERSION: version })
}
if (!existsSync(join(webDist, 'index.html'))) throw new Error('apps/web/dist is missing; build the dashboard first')

// An entry that embeds every dashboard file and registers where each one ended up.
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}
const files = walk(webDist).filter(f => !f.endsWith('_headers'))
const generated = join(root, 'src', 'generated')
mkdirSync(generated, { recursive: true })
const entry = join(generated, 'entry.ts')
writeFileSync(entry, [
  `import { setEmbeddedAssets } from '../http/static.ts'`,
  `import { run } from '../main.ts'`,
  ...files.map((file, i) => `import f${i} from ${JSON.stringify(relative(generated, file).replaceAll('\\', '/'))} with { type: 'file' }`),
  `setEmbeddedAssets({`,
  ...files.map((file, i) => `  ${JSON.stringify('/' + relative(webDist, file).replaceAll('\\', '/'))}: f${i},`),
  `})`,
  `await run()`,
  '',
].join('\n'))

// The update-signing public key: CI can pass it, otherwise the committed file (see scripts/release-key.ts).
const keyFile = join(root, 'release-public-key.txt')
const releaseKey = process.env.MD_RELEASE_PUBLIC_KEY ?? (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '')
if (!releaseKey) console.warn('No release public key: this build will open the release page instead of installing updates')

mkdirSync(dist, { recursive: true })
const outfile = join(dist, name + exe)
const result = await Bun.build({
  entrypoints: [entry],
  compile: {
    target,
    outfile,
    // A downloaded executable must not pick up .env or bunfig files from whatever folder it runs in.
    autoloadDotenv: false,
    autoloadBunfig: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
    windows: {
      hideConsole: true,
      icon: join(root, 'assets', 'TrayIcon.ico'),
      title: 'MediaDownloader',
      publisher: 'CodeFusion',
      version: version.replace(/-.*/, '') + '.0',
      description: 'MediaDownloader',
    },
  },
  plugins: [stubWebrtc],
  external: ['utp-native'],
  define: {
    MD_VERSION: JSON.stringify(version),
    MD_RELEASE_PUBLIC_KEY: JSON.stringify(releaseKey),
  },
  minify: true,
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.log(`Built ${relative(process.cwd(), outfile)}`)

if (os === 'darwin') await packageMacApp()

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
