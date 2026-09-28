import { existsSync } from 'node:fs'
import { join, normalize } from 'node:path'

/**
 * The dashboard's built files. A release build embeds them in the executable and registers them
 * here (see build.ts); a dev run serves apps/web/dist if it has been built.
 */
let embedded: Record<string, string> | null = null

export function setEmbeddedAssets(assets: Record<string, string>): void {
  embedded = assets
}

const WEB_DIST = join(import.meta.dir, '..', '..', '..', 'web', 'dist')

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
}

function resolveFile(path: string): string | undefined {
  if (embedded) return embedded[path]
  const file = join(WEB_DIST, path)
  return path !== '/' && existsSync(file) ? file : undefined
}

export async function staticAsset(pathname: string): Promise<Response> {
  let path: string
  try {
    path = normalize(decodeURIComponent(pathname)).replaceAll('\\', '/')
  } catch {
    return new Response('Bad request', { status: 400 })
  }
  const hashed = path.startsWith('/assets/')
  // Client-side routes fall back to the app shell; a missing hashed asset is a real 404.
  const file = resolveFile(path) ?? (hashed ? undefined : resolveFile('/index.html'))
  if (!file) {
    return new Response('The dashboard has not been built. Run `bun run build:web`, or use the Vite dev server.', { status: 404 })
  }
  return new Response(Bun.file(file), {
    headers: { ...SECURITY_HEADERS, 'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache' },
  })
}
