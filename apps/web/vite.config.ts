import { buildIdentity, privateSourceMaps, versionFile } from '@codefusion-cc/console/vite'
import { prePaintTheme } from '@codefusion-cc/theme/vite'
import { join } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { themeConfig } from './src/ui/themeConfig.ts'

/**
 * In development the dashboard talks either to a local client (`npm run dev:client`, port 47820, or
 * MAGNETAR_CLIENT_PORT) or to the Worker (port 8790); MAGNETAR_WEB_TARGET picks which one Vite proxies to.
 */
const repo = join(import.meta.dirname, '../..')
// The packaging script names the version it builds; a plain build (the Worker's deploy) takes the repo's.
const build = buildIdentity(repo)
process.env.VITE_APP_VERSION ??= build.version

const target = process.env.MAGNETAR_WEB_TARGET === 'cloud' ? 'http://localhost:8790' : `http://localhost:${process.env.MAGNETAR_CLIENT_PORT ?? 47820}`

export default defineConfig({
  // version.json for CodeFusion Console's Deployments page; source maps only the Worker reads (dist/_console/),
  // to show website failures with their own files and lines. The desktop app leaves the maps out (assets.rs).
  // prePaintTheme: /theme.js, first in <head>, shows the remembered theme before first paint.
  plugins: [react(), tailwindcss(), versionFile({ root: repo }), privateSourceMaps(), prePaintTheme(themeConfig)],
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
  },
})
