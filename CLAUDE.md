# Magnetar

Monorepo: `packages/protocol` (TypeScript: the RPC contract and E2E crypto for the dashboard and Worker),
`apps/client` (Rust: the single-executable app), `apps/web` (React/daisyUI dashboard, served by both the app and the
Worker), `apps/worker` (Cloudflare Worker). npm workspaces on Node 24 for the TypeScript, a Cargo workspace at the
root for Rust.
See docs/ARCHITECTURE.md before touching the relay, pairing or either `e2e` implementation.

- Checks: `npm run check` (oxlint, clippy with `-D warnings`, `cargo fmt --check`, tsc for every package, Vitest,
  cargo test). Vitest runs the `packages/*` and `apps/web` tests in Node, and `apps/worker/test` in workerd with a local
  D1 and the real relay (`apps/worker/vitest.config.ts`, the dev environment's bindings, its own tsconfig). Cargo needs
  `/opt/homebrew/opt/rustup/bin` on PATH on the maintainer's Mac.
- Scripts (`scripts/`, `apps/client/package.ts`) are TypeScript that Node runs as is: erasable syntax only, relative
  imports with their `.ts` extension.
- The wire contract lives twice: zod schemas and types in `packages/protocol/src/{model,rpc}.ts`, serde types in
  `apps/client/src/protocol/model.rs`. Change both together. The E2E handshake is also implemented twice and both
  must keep matching `packages/protocol/src/e2e-vector.json`.
- A new RPC method: schema and result type in `packages/protocol/src/rpc.ts`, handler in `apps/client/src/rpc.rs`.
  Anything an agent can do also goes through `apps/client/src/api/actions.rs` so REST, MCP and the dashboard agree.
- New settings: add to `AppSettings` in `apps/client/src/settings.rs` (settings are one JSON row, no migration),
  `SettingsDto`/`SettingsPatch` in both protocol files. Schema changes to tables: append a migration in
  `apps/client/src/db.rs`, never edit a shipped one.
- New user-facing strings: add the key to all eight `apps/web/src/i18n/*.json` catalogs.
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
  base64url (`randomToken`, `random_token`). Route patterns keep accepting `A-Za-z0-9_-` for older ids.
- On the website a device's pages are `/<device name>/…`. A new top-level route there needs its word in
  `packages/protocol/src/device-names.json` (`reserved`), and a D1 migration renaming any device that has it. Pages
  are served by the Worker (`page()` in `apps/worker/src/index.ts`) so the assets never respell an address.
- Test and scratch runs: set `MAGNETAR_DATA_DIRECTORY` and `MAGNETAR_DOWNLOAD_FOLDER`, or they use the user's real folders.
- `npm run e2e` drives the real app with Playwright; its specs end in `.e2e.ts` so Vitest skips them.
- Dev ports: app 47820, Vite 5173, Worker 8790.
