import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * In development the dashboard talks either to a local client (`bun run dev:client`, port 47820, or
 * MAGNETAR_CLIENT_PORT) or to the Worker (port 8790); MAGNETAR_WEB_TARGET picks which one Vite proxies to.
 */
const target = process.env.MAGNETAR_WEB_TARGET === 'cloud' ? 'http://localhost:8790' : `http://localhost:${process.env.MAGNETAR_CLIENT_PORT ?? 47820}`

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
    sourcemap: false,
    chunkSizeWarningLimit: 800,
  },
})
