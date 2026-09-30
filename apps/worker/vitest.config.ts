import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// The Worker in workerd with the dev environment's bindings (local D1, the relay, rate limits,
// dev sign-in, no CodeFusion Console) and the schema from migrations/, applied in test/setup.ts.
// env.dev deliberately has no CodeFusion Console binding; wrangler would warn about it for every file.
process.env.WRANGLER_LOG ??= 'error'

export default defineConfig(async () => {
  const migrations = await readD1Migrations(new URL('./migrations', import.meta.url).pathname)
  return {
    plugins: [cloudflareTest({
      wrangler: { configPath: new URL('./wrangler.jsonc', import.meta.url).pathname, environment: 'dev' },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    })],
    test: {
      name: 'worker',
      root: import.meta.dirname,
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/setup.ts'],
    },
  }
})
