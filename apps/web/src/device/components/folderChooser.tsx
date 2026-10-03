import { CircleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { isWithin, separatorOf } from '../../lib/folderPaths.ts'
import { useT } from '../../lib/i18n.tsx'
import { Loading } from '../../ui/Loading.tsx'
import { useDevice } from '../DeviceContext.tsx'
import { FolderPanel, RootList, useRoots } from './files.tsx'

/**
 * The folders of the device that can be browsed, and their subfolders, to choose one: it starts in `start` when that
 * is inside one of them, else at the list of them. Tells `onPath` the folder on screen, or null on the list.
 */
export function Chooser({ start, onPath }: { start: string; onPath: (path: string | null) => void }) {
  const t = useT()
  const { connection, deviceName } = useDevice()
  const { supported, roots, error, setRoots } = useRoots()
  const [path, setPath] = useState<string | null>(null)
  const [placed, setPlaced] = useState(false)
  useEffect(() => {
    if (placed || !roots) return
    const wanted = start.trim()
    const inside = wanted !== '' && roots.roots.some(r => isWithin(wanted, r.path, separatorOf(r.path)))
    setPath(inside ? wanted : null)
    setPlaced(true)
  }, [roots, start, placed])
  useEffect(() => onPath(path), [path, onPath])

  if (!supported) {
    return (
      <p className="flex items-start gap-2 text-sm"><CircleAlert size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
        {t(connection.kind === 'local' ? 'files.updateLocal' : 'files.updateRemote', deviceName)}</p>
    )
  }
  if (error && !roots) return <p role="alert" className="text-sm text-error">{error}</p>
  if (!roots || !placed) return <Loading />
  return path === null
    ? <RootList compact roots={roots.roots} canAdd={roots.canAdd} onOpen={setPath} onChanged={setRoots} />
    : <FolderPanel compact foldersOnly path={path} roots={roots.roots} onOpen={setPath} onHome={() => setPath(null)} />
}
