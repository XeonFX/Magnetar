import { afterAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerMessage } from '@md/protocol'
import { App } from '../src/app.ts'
import { newResult, type TorrentSearchProvider } from '../src/search/types.ts'

const dir = mkdtempSync(join(tmpdir(), 'md-app-'))

/** The legacy .NET schema, as EF Core created it (see the maintainer's database). */
function legacyDatabase(): string {
  const path = join(dir, 'legacy.db')
  const db = new Database(path)
  db.exec(`
    CREATE TABLE "SeriesTasks" ("Id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "Name" TEXT NOT NULL, "Query" TEXT NOT NULL,
      "Provider" TEXT NULL, "TitleFilter" TEXT NULL, "Season" INTEGER NULL, "StartEpisode" INTEGER NOT NULL, "EndEpisode" INTEGER NULL,
      "DownloadFolder" TEXT NULL, "LastDownloadedEpisode" INTEGER NOT NULL, "CheckIntervalMinutes" INTEGER NOT NULL, "Enabled" INTEGER NOT NULL,
      "LastCheckedAt" TEXT NULL, "CreatedAt" TEXT NOT NULL);
    CREATE TABLE "Settings" ("Id" INTEGER NOT NULL PRIMARY KEY, "DownloadFolder" TEXT NOT NULL, "NotifyOnStart" INTEGER NOT NULL,
      "NotifyOnComplete" INTEGER NOT NULL, "EmailEnabled" INTEGER NOT NULL, "SmtpHost" TEXT NOT NULL, "SmtpPort" INTEGER NOT NULL,
      "SmtpUseSsl" INTEGER NOT NULL, "SmtpUsername" TEXT NOT NULL, "SmtpPassword" TEXT NOT NULL, "EmailFrom" TEXT NOT NULL, "EmailTo" TEXT NOT NULL,
      "DesktopEnabled" INTEGER NOT NULL, "PushEnabled" INTEGER NOT NULL, "NtfyServer" TEXT NOT NULL, "NtfyTopic" TEXT NOT NULL,
      "TelegramEnabled" INTEGER NOT NULL, "TelegramBotToken" TEXT NOT NULL, "TelegramChatId" TEXT NOT NULL,
      "PostDownloadAction" INTEGER NOT NULL DEFAULT 0, "DisabledProviders" TEXT NOT NULL DEFAULT '', "Language" TEXT NOT NULL DEFAULT 'en',
      "AgentApiAllowRemote" INTEGER NOT NULL DEFAULT 0, "AgentApiEnabled" INTEGER NOT NULL DEFAULT 0, "AgentApiToken" TEXT NOT NULL DEFAULT '');
    CREATE TABLE "Downloads" ("Id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "Name" TEXT NOT NULL, "MagnetUri" TEXT NOT NULL,
      "InfoHash" TEXT NOT NULL, "SavePath" TEXT NOT NULL, "Source" TEXT NOT NULL, "Status" INTEGER NOT NULL, "Progress" REAL NOT NULL,
      "TotalBytes" INTEGER NOT NULL, "AddedAt" TEXT NOT NULL, "CompletedAt" TEXT NULL, "Error" TEXT NULL, "StartNotificationSent" INTEGER NOT NULL,
      "CompleteNotificationSent" INTEGER NOT NULL, "SeriesTaskId" INTEGER NULL, "TorrentFilePath" TEXT NULL, "NameIsPlaceholder" INTEGER NOT NULL DEFAULT 0);
    INSERT INTO "SeriesTasks" VALUES (7, 'Frieren', 'Frieren 1080p', 'Nyaa', 'SubsPlease', NULL, 1, 28, NULL, 12, 60, 1, '2026-09-01 10:00:00.1234567', '2026-07-01 09:00:00');
    INSERT INTO "Settings" VALUES (1, '/Volumes/Media', 1, 0, 1, 'smtp.example.com', 465, 1, 'me', 'CfDJ8-encrypted', 'me@example.com', 'me@example.com',
      1, 0, 'https://ntfy.sh', '', 0, '', '', 1, 'PTE,EZTV', 'pl', 0, 1, 'CfDJ8-token');
    INSERT INTO "Downloads" VALUES (1, 'Frieren - 12', 'magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&dn=x', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      '/Volumes/Media', 'Nyaa', 5, 100, 1000, '2026-09-01 10:00:00', '2026-09-01 11:00:00', NULL, 1, 1, 7, NULL, 0);
    INSERT INTO "Downloads" VALUES (2, 'Ubuntu', 'magnet:?xt=urn:btih:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      '/Volumes/Media', 'RARBG', 2, 40, 5000, '2026-09-02 10:00:00', NULL, NULL, 1, 0, NULL, NULL, 0);
    INSERT INTO "Downloads" VALUES (3, 'Private', '', 'pte-1', '/Volumes/Media', 'PTE', 2, 10, 5000, '2026-09-02 10:00:00', NULL, NULL, 1, 0, NULL, '/x.torrent', 0);
  `)
  db.close()
  return path
}

const fakeProvider: TorrentSearchProvider = {
  name: 'Fake',
  async search(query) {
    return [
      newResult({ title: `${query} S01E01 1080p`, source: 'Fake', infoHash: 'c'.repeat(40), magnetUri: `magnet:?xt=urn:btih:${'c'.repeat(40)}&dn=x`, seeders: 3 }),
      newResult({ title: 'unrelated', source: 'Fake', infoHash: 'd'.repeat(40), magnetUri: `magnet:?xt=urn:btih:${'d'.repeat(40)}`, seeders: 9 }),
    ]
  },
}

const app = new App({ databasePath: join(dir, 'app.db'), engine: null, providers: [fakeProvider], legacyDatabase: legacyDatabase() })
app.start()
afterAll(() => app.stop())

function connect(local = true) {
  const received: ServerMessage[] = []
  const session = app.rpc.connect({ local, send: message => received.push(message) })
  let id = 0
  const call = async (method: string, params?: unknown) => {
    const callId = ++id
    await session.handle({ id: callId, method, params })
    const reply = received.find(m => 'id' in m && m.id === callId)!
    if ('error' in reply) throw new Error(`${reply.error.code}: ${reply.error.message}`)
    return (reply as { result: unknown }).result as any
  }
  return { call, received, session }
}

describe('rpc', () => {
  test('validates parameters and rejects unknown methods', async () => {
    const { call } = connect()
    await expect(call('nope')).rejects.toThrow(/not_found/)
    await expect(call('downloads.pause', { id: 'x' })).rejects.toThrow(/bad_request/)
  })

  test('device-screen methods are refused through the relay', async () => {
    await expect(connect(false).call('fs.pickNative', {})).rejects.toThrow(/forbidden/)
  })

  test('secrets are write-only', async () => {
    const { call } = connect()
    const updated = await call('settings.update', { telegramBotToken: '123:abc', emailTo: 'me@example.com' })
    expect(updated.telegramBotTokenSet).toBe(true)
    expect(JSON.stringify(updated)).not.toContain('123:abc')
    await expect(call('settings.update', { emailTo: 'not an email' })).rejects.toThrow(/bad_request/)
  })

  test('streams a search to the connection that started it', async () => {
    const { call, received } = connect()
    const { searchId } = await call('search.start', { query: 'Show' })
    await Bun.sleep(20)
    const results = received.filter(m => 'event' in m && m.event === 'search.results')
    expect(results).toHaveLength(1)
    const data = (results[0] as { data: { searchId: string; results: { title: string }[] } }).data
    expect(data.searchId).toBe(searchId)
    // The relevance filter dropped "unrelated".
    expect(data.results.map(r => r.title)).toEqual(['Show S01E01 1080p'])
    expect(received.some(m => 'event' in m && m.event === 'search.done')).toBe(true)
  })
})

describe('downloads without an engine', () => {
  test('add, de-duplicate, pause, resume, delete', async () => {
    const { call } = connect()
    const magnet = `magnet:?xt=urn:btih:${'E'.repeat(40)}&dn=Some+Name`
    const added = await call('downloads.start', { magnet, folder: join(dir, 'dl') })
    expect(added).toMatchObject({ name: 'Some Name', status: 'Queued', source: 'Magnet' })
    expect((await call('downloads.start', { magnet })).id).toBe(added.id)
    expect((await call('downloads.pause', { id: added.id })).status).toBe('Paused')
    expect((await call('downloads.resume', { id: added.id })).status).toBe('Queued')
    await call('downloads.delete', { id: added.id })
    expect((await call('downloads.list')).some((d: { id: number }) => d.id === added.id)).toBe(false)
    await expect(call('downloads.start', { magnet: 'magnet:?xt=urn:btih:zz' })).rejects.toThrow(/info hash/)
  })
})

describe('series rules', () => {
  test('a patch changes only what it names and is validated as a whole', async () => {
    const { call } = connect()
    const created = await call('series.create', { name: 'Show', query: 'Show 1080p', season: 2, startEpisode: 5, enabled: false })
    const renamed = await call('series.update', { id: created.id, patch: { name: 'Renamed' } })
    expect(renamed).toMatchObject({ name: 'Renamed', season: 2, startEpisode: 5, enabled: false })
    expect((await call('series.update', { id: created.id, patch: { season: null } })).season).toBeNull()
    await expect(call('series.update', { id: created.id, patch: { endEpisode: 1 } })).rejects.toThrow(/before startEpisode/)
    await expect(call('series.create', { name: 'x', query: ' ' })).rejects.toThrow(/search query/)
  })
})

describe('legacy import', () => {
  test('copies settings, series and resumable downloads, and lists secrets to re-enter', async () => {
    const { call } = connect()
    const status = await call('legacy.status')
    expect(status).toMatchObject({ available: true, imported: false, downloads: 3, seriesTasks: 1 })
    const result = await call('legacy.import')
    expect(result).toEqual({ downloads: 2, seriesTasks: 1, settings: true, secretsToReenter: ['SMTP password'] })

    const settings = await call('settings.get')
    expect(settings).toMatchObject({ downloadFolder: '/Volumes/Media', language: 'pl', postDownloadAction: 'KeepSeeding', disabledProviders: ['EZTV'], smtpPort: 465 })
    expect(settings.smtpPasswordSet).toBe(false)

    const series = (await call('series.list')).find((s: { name: string }) => s.name === 'Frieren')
    expect(series).toMatchObject({ provider: 'Nyaa', titleFilter: 'SubsPlease', endEpisode: 28, lastDownloadedEpisode: 12, nextEpisode: 13 })
    expect(series.lastCheckedAt).toBe('2026-09-01T10:00:00.123Z')

    const downloads = await call('downloads.list')
    const frieren = downloads.find((d: { name: string }) => d.name === 'Frieren - 12')
    expect(frieren).toMatchObject({ status: 'Completed', seriesTaskId: series.id, progress: 100 })
    // In progress in the old app: imported paused so both apps never write the same files.
    expect(downloads.find((d: { name: string }) => d.name === 'Ubuntu').status).toBe('Paused')
    expect(downloads.some((d: { name: string }) => d.name === 'Private')).toBe(false)
    expect((await call('legacy.status')).imported).toBe(true)
  })
})
