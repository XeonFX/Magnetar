import { buildIdentity, privateSourceMaps, versionFile } from '@codefusion-cc/console/vite'
import { prePaintTheme } from '@codefusion-cc/theme/vite'
import { serviceWorker } from '@codefusion-cc/web-push/vite'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { websiteVersion } from './src/lib/buildVersion.ts'
import { themeConfig } from './src/ui/themeConfig.ts'

/**
 * In development the dashboard talks either to a local client (`npm run dev:client`, port 47820, or
 * MAGNETAR_CLIENT_PORT) or to the Worker (port 8790); MAGNETAR_WEB_TARGET picks which one Vite proxies to.
 */
const repo = join(import.meta.dirname, '../..')
// The packaging script names the version it builds; a plain build (the Worker's deploy) takes the repo's, as a
// development build unless this commit is the one the release tag names.
const build = buildIdentity(repo)
function tagsAtCommit(): string[] {
  const tag = process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME ? [process.env.GITHUB_REF_NAME] : []
  try {
    return [...tag, ...execFileSync('git', ['tag', '--points-at', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')]
  } catch {
    return tag
  }
}
process.env.VITE_APP_VERSION ??= websiteVersion(build.version, tagsAtCommit())

const target = process.env.MAGNETAR_WEB_TARGET === 'cloud' ? 'http://localhost:8790' : `http://localhost:${process.env.MAGNETAR_CLIENT_PORT ?? 47820}`

/** A file only the features page uses: its own, or the package it is made of. */
const featuresPage = (file: string) => file.includes('src/features/') || file.includes('@codefusion-cc/features-page/')

export default defineConfig({
  // version.json for CodeFusion Console's Deployments page; source maps only the Worker reads (dist/_console/),
  // to show website failures with their own files and lines. The desktop app leaves the maps out (assets.rs).
  // prePaintTheme: /theme.js, first in <head>, shows the remembered theme before first paint. serviceWorker: /sw.js,
  // push and relayed playback (src/sw.ts), one classic script outside the hashed bundle.
  plugins: [react(), tailwindcss(), versionFile({ root: repo }), privateSourceMaps(), prePaintTheme(themeConfig), serviceWorker({ entry: 'src/sw.ts' })],
  // The page compares it with /version.json to move onto a newer deploy (src/lib/updates.ts).
  define: { __APP_COMMIT__: JSON.stringify(build.commit) },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/app-config.json': { target, changeOrigin: true },
      '/api': { target, changeOrigin: true, ws: true },
      '/stream': { target, changeOrigin: true },
      '/ws': { target: target.replace('http', 'ws'), ws: true },
    },
  },
  build: {
    target: 'es2023',
    chunkSizeWarningLimit: 800,
    rolldownOptions: {
      output: {
        // The features page, its words and its screenshots in a folder of their own, which the desktop app leaves out
        // (assets.rs): only the website shows that page.
        chunkFileNames: chunk => chunk.facadeModuleId !== null && featuresPage(chunk.facadeModuleId)
          ? 'assets/features/[name]-[hash].js'
          : 'assets/[name]-[hash].js',
        assetFileNames: asset => asset.originalFileNames.length > 0 && asset.originalFileNames.every(featuresPage)
          ? 'assets/features/[name]-[hash][extname]'
          : 'assets/[name]-[hash][extname]',
      },
    },
  },
})
