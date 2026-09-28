# MediaDownloader 2

Bun monorepo: `packages/protocol` (shared RPC contract + E2E crypto), `apps/client` (the single-executable app),
`apps/web` (React/daisyUI dashboard, served by both the app and the Worker), `apps/worker` (Cloudflare Worker).
See docs/ARCHITECTURE.md before touching the relay, pairing or `e2e.ts`.

- Checks: `bun run check` (oxlint, tsc for every package, bun test). Worker tests have their own tsconfig in `apps/worker/test`.
- A new RPC method goes in `packages/protocol/src/rpc.ts` (schema + result type) and `apps/client/src/app.ts` (handler).
  Anything an agent can do also goes through `apps/client/src/api/actions.ts` so REST, MCP and the dashboard agree.
- New settings: add to `AppSettings`/`DEFAULT_SETTINGS` (settings are one JSON row, no migration) and `SettingsDto`/`SettingsPatch`.
  Schema changes to tables: append a migration in `apps/client/src/db/database.ts`, never edit a shipped one.
- New user-facing strings: add the key to all eight `apps/web/src/i18n/*.json` catalogs.
- WebTorrent's native WebRTC module is stubbed (`apps/client/stub-webrtc.ts`); `bun run` and `bun test` load it via `dev-preload.ts`.
- Dev ports: app 47820, Vite 5173, Worker 8790.
