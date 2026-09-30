# Magnetar

Monorepo: `packages/protocol` (TypeScript: the RPC contract and E2E crypto for the dashboard and Worker),
`apps/client` (Rust: the single-executable app), `apps/web` (React/daisyUI dashboard, served by both the app and the
Worker), `apps/worker` (Cloudflare Worker). Bun workspaces for the TypeScript, a Cargo workspace at the root for Rust.
See docs/ARCHITECTURE.md before touching the relay, pairing or either `e2e` implementation.

- Checks: `bun run check` (oxlint, clippy with `-D warnings`, `cargo fmt --check`, tsc for every package, bun test,
  cargo test). Worker tests have their own tsconfig in `apps/worker/test`. Cargo needs `/opt/homebrew/opt/rustup/bin`
  on PATH on the maintainer's Mac.
- The wire contract lives twice: zod schemas and types in `packages/protocol/src/{model,rpc}.ts`, serde types in
  `apps/client/src/protocol/model.rs`. Change both together. The E2E handshake is also implemented twice and both
  must keep matching `packages/protocol/src/e2e-vector.json`. Data both sides need lives once as JSON in
  `packages/protocol/src` and the Rust side reads it with `include_str!` (`push-services.json`).
- A new RPC method: schema and result type in `packages/protocol/src/rpc.ts`, handler in `apps/client/src/rpc.rs`.
  Anything an agent can do also goes through `apps/client/src/api/actions.rs` so REST, MCP and the dashboard agree.
- New settings: add to `AppSettings` in `apps/client/src/settings.rs` (settings are one JSON row, no migration),
  `SettingsDto`/`SettingsPatch` in both protocol files. Schema changes to tables: append a migration in
  `apps/client/src/db.rs`, never edit a shipped one.
- New user-facing strings: add the key to all eight `apps/web/src/i18n/*.json` catalogs.
- Never let librqbit delete files (`Session::delete(.., true)` also removes an emptied output folder, which can be the
  user's download folder); `downloads::engine::delete_files` does it.
- librqbit restores the torrents it had (`session/`) on start; the downloads table decides what runs
  (`Engine::reconcile`). Pause with `Engine::pause` so fast-resume data survives; `Engine::remove` drops it.
- The engine is swapped under a supervisor (`DownloadManager::supervise_engine`): reach it with `self.engine()`, never
  keep an `Arc<Engine>` across an await that could outlive a restart, and add live rows to `downloads.updated` rather
  than re-sending the list.
- Relayed streaming and push go through the encrypted channel only: the Worker forwards opaque bytes (`stream.read`
  replies, sealed push payloads) and must never see a key or plaintext.
- Test and scratch runs: set `MAGNETAR_DATA_DIRECTORY` and `MAGNETAR_DOWNLOAD_FOLDER`, or they use the user's real folders.
- `bun run e2e` drives the real app with Playwright; its specs end in `.e2e.ts` so `bun test` skips them.
- Dev ports: app 47820, Vite 5173, Worker 8790.
