# Magnetar

Monorepo: `packages/protocol` (TypeScript: the RPC contract and E2E crypto for the dashboard and Worker),
`apps/client` (Rust: the single-executable app), `apps/web` (React/daisyUI dashboard, served by both the app and the
Worker), `apps/worker` (Cloudflare Worker). npm workspaces on Node 24 for the TypeScript, a Cargo workspace at the
root for Rust.
See docs/ARCHITECTURE.md before touching the relay, pairing or either `e2e` implementation.

- Checks: `npm run check` (oxlint, clippy with `-D warnings`, `cargo fmt --check`, tsc for every package, Vitest,
  cargo test). Vitest runs the `packages/*` and `apps/web` tests in Node, and `apps/worker/test` in workerd with a local
  D1 and the real relay (`apps/worker/vitest.config.ts`, the dev environment's bindings, its own tsconfig). Cargo needs
  `/opt/homebrew/opt/rustup/bin` on PATH on the maintainer's Mac, where sccache (`~/.cargo/config.toml`, README ›
  Development) shares compiled crates between worktrees. Never give worktrees one `CARGO_TARGET_DIR`: Cargo's
  file-time freshness then hands a worktree another worktree's binary.
- Scripts (`scripts/`, `apps/client/package.ts`) are TypeScript that Node runs as is: erasable syntax only, relative
  imports with their `.ts` extension.
- The wire contract lives twice: zod schemas and types in `packages/protocol/src/{model,rpc}.ts`, serde types in
  `apps/client/src/protocol/model.rs`. Change both together. The E2E handshake is also implemented twice and both
  must keep matching `packages/protocol/src/e2e-vector.json`; Web Push encryption, Rust and the TypeScript package,
  `packages/protocol/src/webpush-vector.json`.
- A new RPC method: schema and result type in `packages/protocol/src/rpc.ts`, handler in `apps/client/src/rpc.rs`.
  Anything an agent can do also goes through `apps/client/src/api/actions.rs` so REST, MCP and the dashboard agree.
- New settings: add to `AppSettings` in `apps/client/src/settings.rs` (settings are one JSON row, no migration),
  `SettingsDto`/`SettingsPatch` in both protocol files. Schema changes to tables: append a migration in
  `apps/client/src/db.rs`, never edit a shipped one.
- New user-facing strings: add the key to all eight `apps/web/src/i18n/*.json` catalogs.
- A feature people can see, new or changed: describe it on the features page (`apps/web/src/features/outline.ts` and
  the same feature in all eight `content/*.ts`; claims must match the code) and retake its shots
  (`npm run screenshots -w @magnetar/e2e -- --only=<shot>`, README "Development").
- Never let librqbit delete files (`Session::delete(.., true)` also removes an emptied output folder, which can be the
  user's download folder); `downloads::engine::delete_files` does it.
- librqbit restores the torrents it had (`session/`) on start; the downloads table decides what runs
  (`Engine::reconcile`). Pause with `Engine::pause` so fast-resume data survives; `Engine::remove` drops it. Call
  either while the downloads are still locked: the torrent then counts as leaving before an attach could take it up.
- The engine is swapped under a supervisor (`DownloadManager::supervise_engine`): reach it with `self.engine()`, never
  keep an `Arc<Engine>` across an await that could outlive a restart, and add live rows to `downloads.updated` rather
  than re-sending the list.
- Relayed streaming and push go through the encrypted channel only: the Worker forwards opaque bytes (`stream.read`
  replies, sealed push payloads) and must never see a key or plaintext.
- Ids people see (devices, accounts, pairings, searches, streams) are base58: `randomId` from
  `@codefusion-cc/base58` in TypeScript, `encoding::random_id` in Rust. Secrets and values decoded back to bytes stay
  base64url (`randomToken` from `@codefusion-cc/workers-crypto`, `random_token`). Route patterns keep accepting `A-Za-z0-9_-` for older ids.
- On the website a device's pages are `/<device name>/…`. The words the website uses or may use for its own pages
  (`/about`, `/features`, `/changelog`, `/pricing`…) are reserved in `packages/protocol/src/device-names.json`: a new page under a
  reserved word needs nothing else; any other word needs adding there, and a D1 migration renaming any device that has
  it (as `0005_reserve_site_words.sql`). Pages are served by the Worker (`serveSinglePageApp` in
  `apps/worker/src/index.ts`) so the assets never respell an address: keep `not_found_handling` out of
  `apps/worker/wrangler.jsonc`, and `run_worker_first` on `/_console/*` so the source maps stay private.
- Test and scratch runs: set `MAGNETAR_DATA_DIRECTORY` and `MAGNETAR_DOWNLOAD_FOLDER`, or they use the user's real folders.
- `npm run e2e` drives the real app with Playwright; its specs end in `.e2e.ts` so Vitest skips them.
- Every merge to `main` deploys the Worker (the `deploy` job in `.github/workflows/ci.yml`), migrations first: a new
  migration must leave the Worker still running meanwhile working.
- PR titles become the release notes the app's What's new shows (`.github/workflows/release.yml`, grouped by the
  branch type): write them for the people using Magnetar. Label `skip-changelog` what they never notice.
- Dev ports: app 47820, Vite 5173, Worker 8790.
- Merging: once the PR's pre-PR passes are done and CI is green, add the `automerge` label
  (`gh pr edit <n> --add-label automerge`). It merges itself with a merge commit as soon as every check
  is green, as the codefusion-automerge App, so the deploys on `main` still run; PRs stacked on it move onto
  `main` (codefusion-cc/codefusion `automerge/README.md`). A branch the ruleset wants up to date is brought up to date
  first and merges once its checks pass again. Leave the label off a PR that must wait for something
  else, and never run `gh pr merge` yourself.
