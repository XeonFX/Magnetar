import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { LoginStartupStatus } from '@md/protocol'
import { macAppBundle } from '../paths.ts'

const MAC_LABEL = 'cc.codefusion.mediadownloader.start-at-login'
const WINDOWS_VALUE = 'MediaDownloader'
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

function run(command: string[]): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe', timeout: 5000 })
  return { code: result.exitCode ?? 1, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

/**
 * Starts the app when the user signs in: a per-user LaunchAgent that `open`s the installed .app
 * bundle on macOS, the per-user Run key on Windows. Development runs and other platforms report
 * `unavailable`.
 */
export class LoginStartup {
  private readonly plist = join(homedir(), 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`)

  status(): LoginStartupStatus {
    if (process.platform === 'darwin') {
      if (!macAppBundle()) return 'unavailable'
      if (!existsSync(this.plist)) return 'disabled'
      const overrides = run(['/bin/launchctl', 'print-disabled', `gui/${process.getuid?.() ?? 501}`]).stdout
      return new RegExp(`"${MAC_LABEL.replaceAll('.', '\\.')}"\\s*=>\\s*(true|disabled)`).test(overrides) ? 'requiresApproval' : 'enabled'
    }
    if (process.platform === 'win32') {
      if (!/[\\/]mediadownloader[^\\/]*\.exe$/i.test(process.execPath)) return 'unavailable'
      return run(['reg', 'query', RUN_KEY, '/v', WINDOWS_VALUE]).code === 0 ? 'enabled' : 'disabled'
    }
    return 'unavailable'
  }

  set(enabled: boolean): LoginStartupStatus {
    const status = this.status()
    if (status === 'unavailable') throw new Error('Open the installed app to change login startup.')
    if (process.platform === 'darwin') this.setMac(enabled)
    else this.setWindows(enabled)
    return this.status()
  }

  private setMac(enabled: boolean): void {
    if (!enabled) {
      // Keeps a recoverable copy; the one-shot `open` agent never owns the running app.
      if (existsSync(this.plist)) renameSync(this.plist, `${this.plist}.disabled`)
      return
    }
    const bundle = macAppBundle()!
    const xml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/open</string><string>-g</string><string>${xml(bundle)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
`
    mkdirSync(dirname(this.plist), { recursive: true })
    const temporary = `${this.plist}.${process.pid}.tmp`
    writeFileSync(temporary, plist, { mode: 0o600 })
    run(['/bin/launchctl', 'enable', `gui/${process.getuid?.() ?? 501}/${MAC_LABEL}`])
    renameSync(temporary, this.plist)
  }

  private setWindows(enabled: boolean): void {
    const result = enabled
      ? run(['reg', 'add', RUN_KEY, '/v', WINDOWS_VALUE, '/t', 'REG_SZ', '/d', `"${process.execPath}"`, '/f'])
      : run(['reg', 'delete', RUN_KEY, '/v', WINDOWS_VALUE, '/f'])
    if (result.code !== 0 && enabled) throw new Error(result.stderr.trim() || 'Could not update the Run key.')
  }
}
