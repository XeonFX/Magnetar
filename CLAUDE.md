# MediaDownloader 2

Monorepo: `packages/protocol` (TypeScript: the RPC contract and E2E crypto for the dashboard and Worker),
`apps/client` (Rust: the single-executable app), `apps/web` (React/daisyUI dashboard, served by both the app and the
Worker), `apps/worker` (Cloudflare Worker). Bun workspaces for the TypeScript, a Cargo workspace at the root for Rust.
See docs/ARCHITECTURE.md before touching the relay, pairing or either `e2e` implementation.

- Checks: `bun run check` (oxlint, clippy with `-D warnings`, `cargo fmt --check`, tsc for every package, bun test,
  cargo test). Worker tests have their own tsconfig in `apps/worker/test`. Cargo needs `/opt/homebrew/opt/rustup/bin`
  on PATH on the maintainer's Mac.
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
- Dev ports: app 47820, Vite 5173, Worker 8790.
