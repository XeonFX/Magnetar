import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

/**
 * The dashboard end to end, on the real app (a debug build) with its own data and download folders,
 * no relay and no legacy database. Searches need the torrent sites, so these tests stay away from
 * them; everything else is the product as a user drives it.
 */
const PORT = 47_890
const scratch = mkdtempSync(join(tmpdir(), 'md-e2e-'))

export default defineConfig({
  testDir: './tests',
  // Not *.spec.ts: `bun test` would pick those up as its own.
  testMatch: /\.e2e\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /phone\.e2e\.ts/ },
    { name: 'phone', use: { ...devices['Pixel 7'] }, testMatch: /phone\.e2e\.ts/ },
  ],
  webServer: {
    command: 'bun run --cwd ../web build && cargo run -q -p mediadownloader',
    url: `http://localhost:${PORT}/health`,
    timeout: 600_000,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      MD_PORT: String(PORT),
      MD_DATA_DIRECTORY: join(scratch, 'data'),
      MD_DOWNLOAD_FOLDER: join(scratch, 'downloads'),
      MD_LEGACY_DATABASE: join(scratch, 'no-legacy.db'),
      MD_CLOUD_URL: 'http://127.0.0.1:9',
      MD_NO_TRAY: '1',
      MD_NO_BROWSER: '1',
      PATH: `/opt/homebrew/opt/rustup/bin:${process.env.PATH}`,
    },
  },
})
