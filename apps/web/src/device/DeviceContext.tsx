import type {
  AppInfoDto, DownloadDto, RemoteStatusDto, SearchResultDto, SeriesTaskDto, SettingsDto, SourceDto, SourceOutcomeDto,
  UpdateStatusDto,
} from '@md/protocol'
import { mergeByInfoHash } from '@md/protocol/merge'
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ConnectionState, RpcClient } from '../lib/rpcClient.ts'

/** What the Search page keeps while you browse other pages, like the legacy app did. */
export interface SearchState {
  query: string
  source: string
  resolution: string
  searchId: string | null
  searching: boolean
  results: SearchResultDto[] | null
  outcomes: SourceOutcomeDto[]
}

const EMPTY_SEARCH: SearchState = { query: '', source: '', resolution: '', searchId: null, searching: false, results: null, outcomes: [] }

interface DeviceState {
  connection: RpcClient
  connectionState: ConnectionState
  info: AppInfoDto | null
  series: SeriesTaskDto[]
  settings: SettingsDto | null
  sources: SourceDto[]
  updates: UpdateStatusDto | null
  remote: RemoteStatusDto | null
  search: SearchState
  setSearch: (update: (state: SearchState) => SearchState) => void
  /** Base path of this device's pages: '' locally, '/d/<id>' through the relay. */
  basePath: string
  deviceName: string
}

const DeviceContext = createContext<DeviceState | null>(null)
/** Separate so the once-a-second progress updates re-render only the views that show downloads. */
const DownloadsContext = createContext<DownloadDto[]>([])

export function DeviceProvider({ connection, basePath, deviceName, children }: {
  connection: RpcClient
  basePath: string
  deviceName: string
  children: ReactNode
}) {
  const [connectionState, setConnectionState] = useState<ConnectionState>(connection.state)
  const [info, setInfo] = useState<AppInfoDto | null>(null)
  const [downloads, setDownloads] = useState<DownloadDto[]>([])
  const [series, setSeries] = useState<SeriesTaskDto[]>([])
  const [settings, setSettings] = useState<SettingsDto | null>(null)
  const [sources, setSources] = useState<SourceDto[]>([])
  const [updates, setUpdates] = useState<UpdateStatusDto | null>(null)
  const [remote, setRemote] = useState<RemoteStatusDto | null>(null)
  const [search, setSearch] = useState<SearchState>(EMPTY_SEARCH)

  useEffect(() => {
    const refresh = async () => {
      try {
        const [i, d, s, st, src, u, r] = await Promise.all([
          connection.call('app.info'), connection.call('downloads.list'), connection.call('series.list'),
          connection.call('settings.get'), connection.call('sources.list'), connection.call('updates.status'),
          connection.call('remote.status'),
        ])
        setInfo(i)
        setDownloads(d)
        setSeries(s)
        setSettings(st)
        setSources(src)
        setUpdates(u)
        setRemote(r)
      } catch {
        // The state listener retries on the next successful (re)connect.
      }
    }
    const offState = connection.onState(state => {
      setConnectionState(state)
      if (state.status === 'open') void refresh()
      else setSearch(s => (s.searching ? { ...s, searching: false } : s))
    })
    if (connection.state.status === 'open') void refresh()

    const off = [
      offState,
      connection.on('downloads.changed', setDownloads),
      connection.on('series.changed', setSeries),
      connection.on('settings.changed', next => {
        setSettings(next)
        void connection.call('sources.list').then(setSources).catch(() => {})
      }),
      connection.on('updates.changed', setUpdates),
      connection.on('remote.changed', setRemote),
      connection.on('search.results', ({ searchId, results }) =>
        setSearch(s => (s.searchId === searchId ? { ...s, results: mergeByInfoHash([...(s.results ?? []), ...results]) } : s))),
      connection.on('search.source', ({ searchId, outcome }) =>
        setSearch(s => (s.searchId === searchId ? { ...s, outcomes: [...s.outcomes, outcome] } : s))),
      connection.on('search.done', ({ searchId }) =>
        setSearch(s => (s.searchId === searchId ? { ...s, searching: false } : s))),
      connection.on('notification', event => {
        if (!('Notification' in window) || Notification.permission !== 'granted') return
        try {
          new Notification(event.title, { body: event.message, icon: '/favicon.png' })
        } catch {
          // Some mobile browsers only allow notifications from a service worker.
        }
      }),
    ]
    return () => off.forEach(fn => fn())
  }, [connection])

  const value = useMemo<DeviceState>(() => ({
    connection, connectionState, info, series, settings, sources, updates, remote, search, setSearch, basePath, deviceName,
  }), [connection, connectionState, info, series, settings, sources, updates, remote, search, basePath, deviceName])

  return (
    <DeviceContext.Provider value={value}>
      <DownloadsContext.Provider value={downloads}>{children}</DownloadsContext.Provider>
    </DeviceContext.Provider>
  )
}

export function useDevice(): DeviceState {
  const value = useContext(DeviceContext)
  if (!value) throw new Error('useDevice outside DeviceProvider')
  return value
}


export function useDownloads(): DownloadDto[] {
  return useContext(DownloadsContext)
}
