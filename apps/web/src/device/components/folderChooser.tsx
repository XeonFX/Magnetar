import { CircleAlert } from 'lucide-react'
import { useEffect } from 'react'
import { isWithin, separatorOf } from '../../lib/folderPaths.ts'
import { useT } from '../../lib/i18n.tsx'
import { Loading } from '../../ui/Loading.tsx'
import { useDevice } from '../DeviceContext.tsx'
import { FolderPanel, RootList, useRoots } from './files.tsx'

/**
 * The folders of the device that can be browsed, and their subfolders, to choose one. `path` is the folder on screen,
 * null on the list of them; undefined until it is placed at `start` when that is inside one of them, else the list.
 */
export function Chooser({ start, path, onPath }: { start: string; path: string | null | undefined; onPath: (path: string | null) => void }) {
  const t = useT()
  const { connection, deviceName } = useDevice()
  const { supported, roots, error, setRoots } = useRoots()
  useEffect(() => {
    if (path !== undefined || !roots) return
    const wanted = start.trim()
    onPath(wanted !== '' && roots.roots.some(r => isWithin(wanted, r.path, separatorOf(r.path))) ? wanted : null)
  }, [roots, start, path, onPath])

  if (!supported) {
    return (
      <p className="flex items-start gap-2 text-sm"><CircleAlert size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
        {t(connection.kind === 'local' ? 'files.updateLocal' : 'files.updateRemote', deviceName)}</p>
    )
  }
  if (error && !roots) return <p role="alert" className="text-sm text-error">{error}</p>
  if (!roots || path === undefined) return <Loading />
  return path === null
    ? <RootList compact roots={roots.roots} canAdd={roots.canAdd} onOpen={onPath} onChanged={setRoots} />
    : <FolderPanel compact foldersOnly path={path} roots={roots.roots} onOpen={onPath} onHome={() => onPath(null)} />
}
