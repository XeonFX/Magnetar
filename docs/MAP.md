# Repo map

Magnetar: a single-executable torrent/media downloader (Rust) with a React dashboard, usable locally or from any browser through an end-to-end encrypted relay on a Cloudflare Worker (magnetar.codefusion.cc).
Design and security are in [ARCHITECTURE.md](ARCHITECTURE.md), deploy and signing in [DEPLOY.md](DEPLOY.md), dev setup in [README.md](../README.md) "Development". Agent rules are in [CLAUDE.md](../CLAUDE.md).

## Layout

- `packages/protocol/src/` the wire contract in TypeScript: `rpc.ts` (methods), `model.ts` (types), `e2e.ts` (crypto), `relay.ts`, `device-names.json` (reserved site words), `e2e-vector.json` and `webpush-vector.json` (shared test vectors).
- `apps/client/` the Rust app (crate `magnetar`). `src/rpc.rs` RPC handlers, `src/api/actions.rs` actions shared by REST, MCP and dashboard, `src/http/` local server (REST, MCP, assets, streaming), `src/downloads/` torrent engine and manager, `src/search/` providers, `src/series/` show monitoring, `src/remote/` relay link, browser keys and push, `src/db.rs` SQLite and migrations, `src/settings.rs`, `src/updates/`. Tests in `apps/client/tests/`. `package.ts` builds the release executable.
- `apps/web/src/` the dashboard, one build for both transports: `LocalApp.tsx` (in the app), `cloud/` (website: login, devices, pairing), `device/` (pages of one device), `lib/` (`rpcClient.ts`, `localConnection.ts`, `relayConnection.ts`, `keyStore.ts`), `ui/`, `i18n/` (8 catalogs), `features/` (features page).
- `apps/worker/src/` Cloudflare Worker: `index.ts` routes and `serveSinglePageApp`, `relay.ts` (`DeviceRelay` Durable Object), `auth.ts` (Google sign-in, sessions), `devices.ts`, `push.ts`, `releases.ts`, `console/`. `migrations/` D1 SQL, `test/` workerd tests, `wrangler.jsonc` (has an `env.dev`).
- `apps/e2e/` Playwright (`tests/*.e2e.ts`) and `features/screenshots.ts`. `scripts/` release signing. `Cargo.toml` is the workspace root.

## Main flows

- Local: browser -> `localhost:47820` (`apps/client/src/http/`) -> WebSocket `/ws` -> `apps/client/src/rpc.rs` -> `downloads/`, `search/`, SQLite.
- Remote: browser -> Worker `/api/*` and WebSocket -> `DeviceRelay` DO (`apps/worker/src/relay.ts`) -> device WebSocket from `apps/client/src/remote/`. Frames after the handshake are sealed; the Worker never sees plaintext.
- Pairing and sign-in: `apps/web/src/cloud/` -> `apps/worker/src/auth.ts` and `devices.ts` -> D1 (`DB`).
- New RPC method: `packages/protocol/src/rpc.ts` -> `apps/client/src/rpc.rs` (+ `api/actions.rs` if agents can do it); the serde mirror is `apps/client/src/protocol/model.rs`.
- Website pages: any path -> Worker `serveSinglePageApp` -> the one dashboard page; device pages live at `/<device name>/...`.

## @codefusion-cc packages

`workers-http` (SPA serving, errors), `workers-crypto` (tokens), `base58` (readable ids), `google-sign-in`, `web-push`, `console` (telemetry, admin pages), `app-update` and `theme` and `i18n` (dashboard), `features-page` (`/features`).

## Tests and checks

- Everything: `npm run check` (lint + typecheck + tests). Parts: `npm run lint` (oxlint, clippy `-D warnings`, `cargo fmt --check`), `npm run typecheck` (every workspace).
- Unit (Node: `packages/*`, `apps/web`): `npx vitest run --project node --maxWorkers=2`. Worker (workerd, local D1 and real relay): `npx vitest run apps/worker`.
- Rust: `export PATH="/opt/homebrew/opt/rustup/bin:$PATH" && cargo test --locked -j4`.
- E2E: `npm run e2e` (Playwright drives the real app; needs `npm run build:web` and `npx playwright install chromium`).

## Deploy and migrations

- Merge to `main`: the `deploy` job in `.github/workflows/ci.yml` (after checks and e2e) builds the dashboard, runs `wrangler d1 migrations apply magnetar --remote`, then `wrangler deploy`. No preview environments; try locally with `npm run dev:worker`.
- Worker D1 migrations: add `apps/worker/migrations/NNNN_name.sql`; the old Worker must keep working during the deploy. App-side SQLite migrations are in `apps/client/src/db.rs` (append only).
- App release: tag `vX.Y.Z` after bumping versions (`.github/workflows/release.yml`); PR titles become the "What's new" notes.

## Gotchas

- The contract exists twice (zod in `packages/protocol`, serde in `apps/client/src/protocol`) and the E2E handshake twice; change both and keep the vector files passing.
- Never share one `CARGO_TARGET_DIR` between worktrees. Dev ports: app 47820, Vite 5173, Worker 8790.
- Test runs of the app need `MAGNETAR_DATA_DIRECTORY` and `MAGNETAR_DOWNLOAD_FOLDER`, or they touch the real folders.
- Never delete torrent files through librqbit; use `downloads::engine::delete_files`.
- New user strings go into all eight `apps/web/src/i18n/*.json`; visible features also into `apps/web/src/features/outline.ts` and `content/`.
- Scripts are TypeScript run by Node directly: erasable syntax only, relative imports with `.ts`.
- Keep `not_found_handling` out of `apps/worker/wrangler.jsonc`.
