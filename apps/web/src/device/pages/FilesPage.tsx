import type { FolderEntryDto, FolderPageDto } from '@magnetar/protocol'
import { CircleAlert, Download, FolderSearch } from 'lucide-react'
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { baseName, isWithin } from '../../lib/folderPaths.ts'
import { useT } from '../../lib/i18n.tsx'
import { PageHeader } from '../../ui/controls.tsx'
import { Empty } from '../../ui/Empty.tsx'
import { Loading } from '../../ui/Loading.tsx'
import { useToast } from '../../ui/toast.tsx'
import { useDevice, useDownloads } from '../DeviceContext.tsx'
import { DownloadDetailsDialog } from '../components/downloadDetails.tsx'
import { isFinished } from '../components/downloads.tsx'
import { DownloadFileActions, FolderPanel, RootList, useRoots } from '../components/files.tsx'
import { PlayerDialog, subtitlesFor, type PlayTarget } from '../components/player.tsx'
import { useRun } from '../useRun.ts'

/**
 * Where Files is: the folder shown, in the page's history entry rather than its address, so a path on the device
 * never reaches the website's server or its logs. Back and Forward still step through the folders.
 */
export interface FilesLocation {
  path?: string
}

/** The device's download folder and the folders added on it: browse them, play what was downloaded, choose a folder. */
export function FilesPage() {
  const t = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const { info, deviceName, connection, settings } = useDevice()
  const { supported, roots, error, reload, setRoots } = useRoots()
  const path = (location.state as FilesLocation | null)?.path ?? null
  const open = (next: string | null) => navigate(location.pathname, { state: next === null ? null : { path: next } satisfies FilesLocation })

  if (!info) return <Loading />
  if (!supported) {
    return (
      <>
        <PageHeader title={t('files.title')} />
        <Empty icon={<FolderSearch size={40} className="text-primary" />} title={t('files.updateTitle')}
          text={t(connection.kind === 'local' ? 'files.updateLocal' : 'files.updateRemote', deviceName)} />
      </>
    )
  }
  return (
    <>
      <PageHeader title={t('files.title')} summary={path === null ? t('files.summary') : undefined} />
      {error && !roots && (
        <div role="alert" className="alert alert-soft alert-warning mb-4">
          <CircleAlert size={18} aria-hidden /><span className="flex-1">{error}</span>
          <button type="button" className="btn btn-sm" onClick={reload}>{t('common.retry')}</button>
        </div>
      )}
      {!roots
        ? !error && <Loading />
        : path === null
          ? <RootList roots={roots.roots} canAdd={roots.canAdd} onOpen={open} onChanged={setRoots} />
          : <Folder path={path} roots={roots.roots} downloadFolder={settings?.downloadFolder ?? null} onOpen={open} onHome={() => open(null)} />}
    </>
  )
}

function Folder({ path, roots, downloadFolder, onOpen, onHome }: {
  path: string
  roots: NonNullable<ReturnType<typeof useRoots>['roots']>['roots']
  downloadFolder: string | null
  onOpen: (path: string) => void
  onHome: () => void
}) {
  const t = useT()
  const run = useRun()
  const toast = useToast()
  const { connection } = useDevice()
  const downloads = useDownloads()
  const [details, setDetails] = useState<number | null>(null)
  const [playing, setPlaying] = useState<PlayTarget | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const play = async (entry: FolderEntryDto) => {
    const owner = entry.download
    if (!owner || owner.index === undefined) return
    setOpening(entry.name)
    const files = await run(() => connection.call('downloads.files', { id: owner.id }), 'files.playFailed')
    setOpening(null)
    const file = files?.find(f => f.index === owner.index)
    if (files && file) setPlaying({ downloadId: owner.id, file, subtitles: subtitlesFor(file, files) })
  }

  const useAsDownloadFolder = async (page: FolderPageDto) => {
    setSaving(true)
    const saved = await run(() => connection.call('settings.update', { downloadFolder: page.path }), 'files.useFailed')
    setSaving(false)
    if (saved) toast(t('files.downloadFolderSet', baseName(page.path, page.separator)), 'success')
  }

  const toolbar = (page: FolderPageDto) => {
    const isDownloadFolder = downloadFolder !== null && isWithin(page.path, downloadFolder, page.separator) && isWithin(downloadFolder, page.path, page.separator)
    return isDownloadFolder
      ? <span className="badge badge-soft badge-primary gap-1"><Download size={12} aria-hidden />{t('files.downloadFolder')}</span>
      : (
        <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={() => void useAsDownloadFolder(page)}>
          {saving ? <span className="loading loading-spinner loading-xs" /> : <Download size={14} aria-hidden />}{t('files.useAsDownloadFolder')}
        </button>
      )
  }

  const finished = playing ? downloads.find(d => d.id === playing.downloadId) : undefined
  return (
    <>
      <FolderPanel path={path} roots={roots} onOpen={onOpen} onHome={onHome} toolbar={toolbar}
        fileActions={entry => <DownloadFileActions entry={entry} playing={opening === entry.name} onPlay={e => void play(e)} onDetails={setDetails} />} />
      <PlayerDialog target={playing} finished={finished ? isFinished(finished) : false} onClose={() => setPlaying(null)} />
      <DownloadDetailsDialog id={details} onClose={() => setDetails(null)} />
    </>
  )
}
