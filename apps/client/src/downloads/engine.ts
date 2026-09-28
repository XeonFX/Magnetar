import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import WebTorrent, { type Torrent } from 'webtorrent'
import { DEFAULT_TRACKERS } from '../search/magnet.ts'
import { logger } from '../log.ts'

const log = logger('engine')

/**
 * `dht.libtorrent.org` comes first on purpose: on some filtered networks the classic routers answer
 * find_node with one node repeated eight times, which stalls the DHT lookup (verified: identical
 * under Node, so not a runtime bug). libtorrent's router returns distinct nodes.
 */
export const DHT_BOOTSTRAP = [
  'dht.libtorrent.org:25401',
  'router.bittorrent.com:6881',
  'dht.transmissionbt.com:6881',
  'router.utorrent.com:6881',
]

/** Live state of one torrent, as the download manager needs it. */
export interface EngineTorrent extends EventEmitter {
  readonly infoHash: string
  /** Null until metadata arrives. */
  readonly name: string | null
  readonly hasMetadata: boolean
  readonly totalBytes: number
  /** 0–1 */
  readonly progress: number
  readonly downloadSpeed: number
  readonly uploadSpeed: number
  readonly peers: number
  /** The .torrent bytes once metadata is known, for fast re-attach after a restart. */
  readonly torrentFile: Uint8Array | null
  /** Folder that holds only this torrent's files (multi-file torrents), or null. */
  readonly contentDirectory: string | null
}

/** Emits: 'metadata', 'ready', 'done', 'error' (Error). */
export interface TorrentEngine {
  add(source: string | Uint8Array, savePath: string): EngineTorrent
  remove(torrent: EngineTorrent, deleteFiles: boolean): Promise<void>
  /** DHT nodes worth remembering for the next start. */
  knownNodes(): { host: string; port: number }[]
  destroy(): Promise<void>
}

class WebTorrentHandle extends EventEmitter implements EngineTorrent {
  constructor(readonly torrent: Torrent) {
    super()
    torrent.on('metadata', () => this.emit('metadata'))
    torrent.on('ready', () => this.emit('ready'))
    torrent.on('done', () => this.emit('done'))
    torrent.on('error', (error: unknown) => this.emit('error', error instanceof Error ? error : new Error(String(error))))
    torrent.on('warning', (warning: unknown) => log.debug(`${torrent.infoHash}: ${String(warning)}`))
  }

  get infoHash() { return this.torrent.infoHash }
  get hasMetadata() { return Boolean(this.torrent.files?.length) }
  get name() { return this.hasMetadata ? this.torrent.name : null }
  get totalBytes() { return this.hasMetadata ? this.torrent.length : 0 }
  get progress() { return this.hasMetadata ? this.torrent.progress : 0 }
  get downloadSpeed() { return Math.round(this.torrent.downloadSpeed) }
  get uploadSpeed() { return Math.round(this.torrent.uploadSpeed) }
  get peers() { return this.torrent.numPeers }
  get torrentFile() { return this.torrent.torrentFile ?? null }

  get contentDirectory(): string | null {
    if (!this.hasMetadata) return null
    const files = this.torrent.files
    // A single-file torrent writes straight into the shared save folder, which is never "its" folder.
    if (files.length === 1 && !files[0]!.path.includes('/') && !files[0]!.path.includes('\\')) return null
    return join(this.torrent.path, this.torrent.name)
  }
}

export class WebTorrentEngine implements TorrentEngine {
  private readonly client: WebTorrent

  constructor(savedNodes: { host: string; port: number }[] = []) {
    this.client = new WebTorrent({ utp: false, dht: { bootstrap: DHT_BOOTSTRAP }, maxConns: 55 })
    this.client.on('error', (error: unknown) => log.error('Torrent engine error', error))
    for (const node of savedNodes.slice(0, 200)) {
      try {
        this.client.dht?.addNode(node)
      } catch {
        // A stale or malformed saved node is not worth failing startup over.
      }
    }
  }

  add(source: string | Uint8Array, savePath: string): EngineTorrent {
    const torrent = this.client.add(source, { path: savePath, announce: DEFAULT_TRACKERS, destroyStoreOnDestroy: false })
    return new WebTorrentHandle(torrent)
  }

  remove(handle: EngineTorrent, deleteFiles: boolean): Promise<void> {
    const torrent = (handle as WebTorrentHandle).torrent
    return new Promise(resolve => {
      if (!this.client.torrents.includes(torrent)) return resolve()
      void this.client.remove(torrent, { destroyStore: deleteFiles }, error => {
        if (error) log.warn(`Removing ${torrent.infoHash} reported an error`, error)
        resolve()
      })
    })
  }

  knownNodes(): { host: string; port: number }[] {
    try {
      return this.client.dht?.toJSON().nodes.slice(0, 200) ?? []
    } catch {
      return []
    }
  }

  destroy(): Promise<void> {
    return new Promise(resolve => this.client.destroy(() => resolve()))
  }
}
