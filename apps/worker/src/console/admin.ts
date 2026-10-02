import type { ActionCall, Actor, AppRecord, ListQuery, ListResult, ResourceHandlers } from '@codefusion-cc/console/worker'
import { removeDevice, signOutDashboards } from '../devices.ts'
import type { Env } from '../env.ts'

/**
 * The handlers behind the manifest (./manifest.ts), reached only over the console's service binding. The
 * console checks permissions and removes sensitive fields before anything is shown; searching by a sensitive
 * field is refused here, since a hit would tell a member without pii:read whose account it is.
 */

type Row = Record<string, unknown>
interface Where { sql: string; params: unknown[] }

const MAX_PAGE = 100
const may = (actor: Actor, permission: Actor['permissions'][number]) => actor.permissions.includes(permission)
const iso = (ms: unknown) => (typeof ms === 'number' ? new Date(ms).toISOString() : null)
const like = (text: string) => `%${text.replace(/[\\%_]/g, c => `\\${c}`)}%`
/** `?, ?, ?`: one placeholder per value. */
const marks = (values: unknown[]) => values.map(() => '?').join(', ')

interface Spec {
  /** FROM, with joins. */
  from: string
  /** The primary key column, as the FROM names it. */
  key: string
  columns: string
  /** Expressions searched with LIKE; `pii` ones only for members allowed to read personal data. */
  search: { sql: string; pii?: boolean }[]
  filters: Record<string, (value: string) => Where | null>
  sorts: Record<string, string>
  record: (row: Row) => AppRecord
}

/** One page, newest first unless asked otherwise: offset paging (`cursor` is how many rows to skip), with the total. */
async function list(env: Env, spec: Spec, query: ListQuery, actor: Actor): Promise<ListResult> {
  const where: Where[] = []
  const search = query.search?.trim()
  if (search) {
    const terms = spec.search.filter(term => !term.pii || may(actor, 'pii:read'))
    where.push({ sql: `(${terms.map(term => `${term.sql} LIKE ? ESCAPE '\\'`).join(' OR ')})`, params: terms.map(() => like(search)) })
  }
  for (const [key, value] of Object.entries(query.filters ?? {})) {
    const filter = spec.filters[key]?.(value)
    if (filter) where.push(filter)
  }
  const sort = query.sort && spec.sorts[query.sort.key] ? query.sort : { key: Object.keys(spec.sorts)[0]!, dir: 'desc' as const }
  const offset = Math.max(0, Math.floor(Number(query.cursor)) || 0)
  const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(query.limit) || 25))
  const { results } = await env.DB.prepare(`SELECT ${spec.columns}, COUNT(*) OVER () AS total_count FROM ${spec.from}
    ${where.length ? `WHERE ${where.map(w => w.sql).join(' AND ')}` : ''}
    ORDER BY ${spec.sorts[sort.key]} ${sort.dir === 'asc' ? 'ASC' : 'DESC'}, ${spec.key} DESC LIMIT ? OFFSET ?`)
    .bind(...where.flatMap(w => w.params), limit, offset)
    .all<Row>()
  const total = Number(results[0]?.total_count ?? 0)
  return {
    items: results.map(spec.record),
    nextCursor: offset + results.length < total ? String(offset + results.length) : null,
    total,
  }
}

const accounts: Spec = {
  from: 'users u',
  key: 'u.id',
  columns: `u.id, u.email, u.name, u.created_at, u.last_login_at,
    (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id) AS devices,
    (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > unixepoch('subsec') * 1000) AS sessions`,
  search: [{ sql: 'u.id' }, { sql: 'u.email', pii: true }, { sql: 'u.name', pii: true }],
  filters: {},
  sorts: { last_login_at: 'u.last_login_at', created_at: 'u.created_at', devices: 'devices' },
  record: row => ({
    id: row.id, email: row.email, name: row.name, devices: row.devices, sessions: row.sessions,
    created_at: iso(row.created_at), last_login_at: iso(row.last_login_at),
  }),
}

const devices: Spec = {
  from: 'devices',
  key: 'id',
  columns: 'id, user_id, name, platform, version, online, created_at, last_seen_at',
  search: [{ sql: 'id' }, { sql: 'version' }, { sql: 'platform' }, { sql: 'name', pii: true }],
  filters: {
    online: value => (value === 'yes' ? { sql: 'online = 1', params: [] } : value === 'no' ? { sql: 'online = 0', params: [] } : null),
  },
  sorts: { created_at: 'created_at', last_seen_at: 'last_seen_at' },
  record: row => ({
    id: row.id, name: row.name, platform: row.platform, version: row.version, online: row.online === 1,
    account: row.user_id, created_at: iso(row.created_at), last_seen_at: iso(row.last_seen_at),
  }),
}

async function get(env: Env, spec: Spec, id: string): Promise<AppRecord | null> {
  const row = await env.DB.prepare(`SELECT ${spec.columns} FROM ${spec.from} WHERE ${spec.key} = ?`).bind(id).first<Row>()
  return row ? spec.record(row) : null
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Unpairs the devices whose `column` is one of `values`, as their owners would, so open connections close too. */
async function removeDevices(env: Env, column: 'id' | 'user_id', values: string[]): Promise<number> {
  const { results } = await env.DB.prepare(`SELECT id FROM devices WHERE ${column} IN (${marks(values)})`).bind(...values).all<{ id: string }>()
  await Promise.all(results.map(d => removeDevice(env, d.id)))
  return results.length
}

export const consoleResources: Record<string, ResourceHandlers<Env>> = {
  accounts: {
    list: (query, { env, actor }) => list(env, accounts, query, actor),
    get: (id, { env }) => get(env, accounts, id),
    actions: {
      'sign-out': async ({ env, ids }: ActionCall<Env>) => {
        const result = await env.DB.prepare(`DELETE FROM sessions WHERE user_id IN (${marks(ids)})`).bind(...ids).run()
        // Dashboards already open on the accounts' devices end with their sessions; the devices stay paired.
        await signOutDashboards(env, ids)
        return { ok: true, message: `Signed out ${count(result.meta.changes, 'browser', 'browsers')}` }
      },
      delete: async ({ env, ids }: ActionCall<Env>) => {
        const removed = await removeDevices(env, 'user_id', ids)
        // Sessions, devices and approved pairings go with the account (ON DELETE CASCADE).
        const result = await env.DB.prepare(`DELETE FROM users WHERE id IN (${marks(ids)})`).bind(...ids).run()
        if (!result.meta.changes) return { ok: false, message: 'No such account' }
        return { ok: true, message: `Deleted the account and ${count(removed, 'device', 'devices')}` }
      },
    },
  },
  devices: {
    list: (query, { env, actor }) => list(env, devices, query, actor),
    get: (id, { env }) => get(env, devices, id),
    actions: {
      remove: async ({ env, ids }: ActionCall<Env>) => {
        const removed = await removeDevices(env, 'id', ids)
        if (!removed) return { ok: false, message: 'Already removed' }
        return { ok: true, message: `Removed ${count(removed, 'device', 'devices')}` }
      },
    },
  },
}
