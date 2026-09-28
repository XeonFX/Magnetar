declare module 'webtorrent' {
  import { EventEmitter } from 'node:events'

  interface TorrentFile {
    name: string
    path: string
    length: number
  }

  interface Torrent extends EventEmitter {
    infoHash: string
    name: string
    path: string
    length: number
    progress: number
    downloaded: number
    downloadSpeed: number
    uploadSpeed: number
    numPeers: number
    ready: boolean
    done: boolean
    paused: boolean
    files: TorrentFile[]
    torrentFile: Uint8Array | null
    destroy(opts?: { destroyStore?: boolean }, cb?: (err?: Error) => void): void
  }

  interface WebTorrentOptions {
    utp?: boolean
    dht?: boolean | { bootstrap?: string[] }
    tracker?: boolean | object
    lsd?: boolean
    natUpnp?: boolean
    natPmp?: boolean
    webSeeds?: boolean
    maxConns?: number
    torrentPort?: number
    dhtPort?: number
  }

  interface AddOptions {
    path?: string
    announce?: string[]
    destroyStoreOnDestroy?: boolean
  }

  interface DhtNode {
    host: string
    port: number
  }

  class WebTorrent extends EventEmitter {
    constructor(opts?: WebTorrentOptions)
    torrents: Torrent[]
    dht?: { toJSON(): { nodes: DhtNode[] }; addNode(node: DhtNode): void; nodes?: { count(): number } }
    add(torrentId: string | Uint8Array, opts?: AddOptions, onTorrent?: (torrent: Torrent) => void): Torrent
    get(torrentId: string): Promise<Torrent | null> | Torrent | null
    remove(torrentId: string | Torrent, opts?: { destroyStore?: boolean }, cb?: (err?: Error) => void): void
    destroy(cb?: (err?: Error) => void): void
  }

  export default WebTorrent
  export type { Torrent, TorrentFile }
}
