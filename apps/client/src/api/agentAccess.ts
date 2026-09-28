import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, renameSync, writeFileSync } from 'node:fs'
import type { AgentStatusDto } from '@md/protocol'
import type { SecretStore } from '../db/secrets.ts'
import { paths } from '../paths.ts'
import type { SettingsService } from '../settings.ts'

/** 256 bits, base64url so it survives a shell or a JSON config. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Constant-time comparison, so timing doesn't reveal how much of a guess was right. */
export function tokenMatches(presented: string | null, expected: string): boolean {
  if (!presented || !expected) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The agent API switch, its bearer token, and the endpoint file MCP clients discover it through. */
export class AgentAccess {
  baseUrl = 'http://localhost:47820'

  constructor(private readonly settings: SettingsService, private readonly secrets: SecretStore) {}

  get enabled(): boolean {
    return this.settings.get().agentApiEnabled
  }

  get allowRemote(): boolean {
    return this.settings.get().agentApiAllowRemote
  }

  get token(): string {
    return this.secrets.get('agentApiToken')
  }

  status(): AgentStatusDto {
    return {
      enabled: this.enabled,
      allowRemote: this.allowRemote,
      token: this.token,
      baseUrl: this.baseUrl,
      mcpUrl: `${this.baseUrl}/mcp`,
      endpointFile: paths.endpoint,
    }
  }

  set(change: { enabled?: boolean; allowRemote?: boolean }): AgentStatusDto {
    if (change.enabled && !this.token) this.secrets.set('agentApiToken', generateToken())
    this.settings.save({
      ...(change.enabled !== undefined ? { agentApiEnabled: change.enabled } : {}),
      ...(change.allowRemote !== undefined ? { agentApiAllowRemote: change.allowRemote } : {}),
    })
    this.writeEndpointFile()
    return this.status()
  }

  regenerate(): AgentStatusDto {
    this.secrets.set('agentApiToken', generateToken())
    this.writeEndpointFile()
    return this.status()
  }

  /** Publishes the resolved URLs and token, owner-only, written atomically so readers never see half a file. */
  publish(baseUrl: string): void {
    this.baseUrl = baseUrl
    this.writeEndpointFile()
  }

  private writeEndpointFile(): void {
    const json = JSON.stringify({ baseUrl: this.baseUrl, apiUrl: `${this.baseUrl}/api`, mcpUrl: `${this.baseUrl}/mcp`, token: this.token }, null, 2)
    const temporary = `${paths.endpoint}.${process.pid}.tmp`
    writeFileSync(temporary, json, { mode: 0o600 })
    renameSync(temporary, paths.endpoint)
    if (process.platform !== 'win32') chmodSync(paths.endpoint, 0o600)
    else restrictToCurrentUserOnWindows(paths.endpoint)
  }
}

/** Windows ignores POSIX modes: replace inherited ACLs with the current user only. */
function restrictToCurrentUserOnWindows(path: string): void {
  const user = process.env.USERNAME
  if (!user) return
  Bun.spawnSync(['icacls', path, '/inheritance:r', '/grant:r', `${user}:F`], { stdout: 'ignore', stderr: 'ignore' })
}
