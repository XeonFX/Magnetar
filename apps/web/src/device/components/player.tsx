import type { DownloadFileDto } from '@md/protocol'
import { Copy, ExternalLink, Play } from 'lucide-react'
import { useEffect, useState } from 'react'
import { openStream, srtToVtt, type OpenedStream } from '../../lib/streaming.ts'
import { useT } from '../../lib/i18n.tsx'
import { Modal } from '../../ui/Modal.tsx'
import { useCopy } from '../../ui/toast.tsx'
import { useConnection } from '../DeviceContext.tsx'
import { useRun } from '../useRun.ts'

export interface PlayTarget {
  downloadId: number
  file: DownloadFileDto
  /** Subtitle files from the same torrent, offered as tracks. */
  subtitles: DownloadFileDto[]
}

const isAudio = (path: string) => /\.(mp3|m4a|flac|ogg|opus|wav)$/i.test(path)
const baseName = (path: string) => path.split('/').pop()!.replace(/\.[^.]+$/, '')

/** Subtitles that belong to a video: named like it, or every one when the torrent has one video. */
export function subtitlesFor(video: DownloadFileDto, files: DownloadFileDto[]): DownloadFileDto[] {
  const subtitles = files.filter(f => /\.(srt|vtt)$/i.test(f.path) && f.done === f.size)
  const videos = files.filter(f => f.playable && !isAudio(f.path))
  const named = subtitles.filter(s => baseName(s.path).toLowerCase().startsWith(baseName(video.path).toLowerCase()))
  return (named.length > 0 || videos.length > 1 ? named : subtitles).slice(0, 8)
}

/** A subtitle's language from names like "Movie.en.srt" or "Subs/2_English.srt", for the track list. */
function trackLabel(path: string): string {
  const name = baseName(path)
  return name.split(/[._ ]/).pop() || name
}

/**
 * Plays a download's file in the page, while it downloads too: the parts not here yet arrive as
 * the player reaches them. What the browser can't decode gets other ways to watch it.
 */
export function PlayerDialog({ target, finished, onClose }: { target: PlayTarget | null; finished: boolean; onClose: () => void }) {
  return (
    <Modal open={target !== null} title={target ? target.file.path.split('/').pop()! : ''} icon={<Play size={20} />} onClose={onClose} wide>
      {target && <Player target={target} finished={finished} />}
    </Modal>
  )
}

function Player({ target, finished }: { target: PlayTarget; finished: boolean }) {
  const t = useT()
  const run = useRun()
  const copy = useCopy(t('info.copied'))
  const connection = useConnection()
  const local = connection.kind === 'local'
  const [stream, setStream] = useState<OpenedStream | null>(null)
  const [tracks, setTracks] = useState<{ label: string; url: string }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [unplayable, setUnplayable] = useState(false)
  const complete = target.file.done === target.file.size

  useEffect(() => {
    let cancelled = false
    const opened: OpenedStream[] = []
    const blobs: string[] = []
    const name = target.file.path.split('/').pop()!
    void openStream(connection, target.downloadId, target.file.index, name).then(async main => {
      opened.push(main)
      if (cancelled) return main.close()
      setStream(main)
      const loaded = await Promise.all(target.subtitles.map(async sub => {
        try {
          const subStream = await openStream(connection, target.downloadId, sub.index, sub.path.split('/').pop()!)
          opened.push(subStream)
          const text = await (await fetch(subStream.url)).text()
          const url = URL.createObjectURL(new Blob([sub.path.toLowerCase().endsWith('.srt') ? srtToVtt(text) : text], { type: 'text/vtt' }))
          blobs.push(url)
          return { label: trackLabel(sub.path), url }
        } catch {
          return null
        }
      }))
      if (!cancelled) setTracks(loaded.filter(t => t !== null))
    }).catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
      opened.forEach(s => s.close())
      blobs.forEach(url => URL.revokeObjectURL(url))
    }
  }, [connection, target])

  if (error) return <p role="alert" className="text-sm text-error">{error}</p>
  if (!stream) return <div className="flex justify-center py-16"><span className="loading loading-spinner loading-lg text-primary" /></div>
  const absolute = new URL(stream.url, location.href).href
  const Media = isAudio(target.file.path) ? 'audio' : 'video'
  return (
    <div className="flex flex-col gap-3">
      {unplayable ? (
        <div className="rounded-box bg-base-200 p-5 text-sm">
          <p className="font-semibold">{t('player.unsupported')}</p>
          <p className="muted mt-1">{t(local ? 'player.unsupportedLocal' : 'player.unsupportedRemote')}</p>
        </div>
      ) : (
        <Media src={stream.url} controls autoPlay playsInline preload="metadata"
          className={Media === 'video' ? 'aspect-video w-full rounded-box bg-black' : 'w-full'}
          onError={() => setUnplayable(true)}>
          {tracks.map((track, i) => <track key={track.url} kind="subtitles" label={track.label} src={track.url} default={i === 0} />)}
        </Media>
      )}
      {!complete && !unplayable && <p className="muted text-xs">{t('player.partial', Math.round((target.file.done / Math.max(1, target.file.size)) * 100))}</p>}
      {local && (
        <div className="flex flex-wrap gap-2">
          {finished && complete && (
            <button type="button" className="btn btn-sm" onClick={() => void run(() => connection.call('downloads.openFile', { id: target.downloadId, index: target.file.index }))}>
              <ExternalLink size={14} />{t('player.openInPlayer')}
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy(absolute)} title={t('player.copyLinkHint')}>
            <Copy size={14} />{t('player.copyLink')}
          </button>
        </div>
      )}
    </div>
  )
}
