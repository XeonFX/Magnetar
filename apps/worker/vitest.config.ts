import { join } from 'node:path'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// The Worker in workerd with the dev environment's bindings (local D1, the relay, rate limits,
// dev sign-in) and the schema from migrations/, applied in test/setup.ts. The dev environment has
// no CodeFusion Console binding on purpose; wrangler would warn about that for every file.
process.env.WRANGLER_LOG ??= 'error'

export default defineConfig(async () => ({
  plugins: [cloudflareTest({
    wrangler: { configPath: join(import.meta.dirname, 'wrangler.jsonc'), environment: 'dev' },
    miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations(join(import.meta.dirname, 'migrations')) } },
  })],
  test: {
    name: 'worker',
    root: import.meta.dirname,
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    // Each test starts workerd sockets and D1 writes; Windows runners take seconds for the heavier ones.
    testTimeout: 30_000,
  },
}))
