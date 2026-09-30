// Types `env` and `exports` from cloudflare:workers for the tests, as `wrangler types` would.
declare namespace Cloudflare {
  type WorkerEnv = import('../src/env.ts').Env
  interface Env extends WorkerEnv {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[]
  }
  interface GlobalProps {
    mainModule: typeof import('../src/index.ts')
  }
}
