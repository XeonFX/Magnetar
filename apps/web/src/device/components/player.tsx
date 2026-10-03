import type { DownloadFileDto } from '@magnetar/protocol'
import { Copy, ExternalLink, Play } from 'lucide-react'
import { useEffect, useState } from 'react'
import { errorMessage } from '../../lib/errors.ts'
import { loadSubtitles, openStream, type OpenedStream } from '../../lib/streaming.ts'
import { useT } from '../../lib/i18n.tsx'
import { Loading } from '../../ui/Loading.tsx'
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

const baseName = (path: string) => path.split('/').pop()!.replace(/\.[^.]+$/, '')

/** Subtitles that belong to a video: named like it, or every one when the torrent has one video. */
export function subtitlesFor(video: DownloadFileDto, files: DownloadFileDto[]): DownloadFileDto[] {
  const subtitles = files.filter(f => /\.(srt|vtt)$/i.test(f.path) && f.done === f.size)
  const videos = files.filter(f => f.media === 'video')
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
    // Closing the player stops what is still on its way: whatever it opens or makes after that is let go of at once.
    const abort = new AbortController()
    const { signal } = abort
    let main: OpenedStream | null = null
    let blobs: string[] = []
    void openStream(connection, target.downloadId, target.file.index, target.file.path.split('/').pop()!, signal).then(async opened => {
      main = opened
      setStream(opened)
      const loaded = await loadSubtitles(connection, target.downloadId, target.subtitles, signal)
      // A player that opened again (another connection) has its own tracks by now: these must not replace them.
      if (signal.aborted) return
      blobs = loaded.map(track => track.url)
      setTracks(loaded.map(({ file, url }) => ({ label: trackLabel(file.path), url })))
    }).catch((e: unknown) => !signal.aborted && setError(errorMessage(e)))
    return () => {
      abort.abort()
      main?.close()
      blobs.forEach(url => URL.revokeObjectURL(url))
    }
  }, [connection, target])

  if (error) return <p role="alert" className="text-sm text-error">{error}</p>
  if (!stream) return <Loading />
  const absolute = new URL(stream.url, location.href).href
  const Media = target.file.media === 'audio' ? 'audio' : 'video'
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
