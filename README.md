# MediaDownloader

A torrent search-and-download manager that runs as **one self-contained executable** on your computer, with a
React dashboard you can open locally or from anywhere at **[mediadownloader.codefusion.cc](https://mediadownloader.codefusion.cc)**.
Remote access is **end-to-end encrypted**: the website relays data between your browser and your computer, but can't
read what you search for, what you download, or your settings.

> **Legal notice:** downloading copyrighted material without permission may be illegal where you live. Use this for
> content you are entitled to download (Linux ISOs, public-domain and Creative Commons media, your own files).

This is version 2, a rewrite of the .NET/Blazor [MediaDownloader 1.x](https://github.com/XeonFX/MediaDownloader) in
TypeScript. It can import everything from a 1.x installation (see [Upgrading from 1.x](#upgrading-from-1x)).

## Features

- **Search six sources in parallel**, with results streamed in as each answers: The Pirate Bay (apibay API with HTML
  mirror fallback), 1337x (mirrors; magnet and description fetched on demand), RARBG (TheRARBG's JSON API),
  Torrents-CSV, Nyaa and EZTV.
- **Per-source outcomes** above the results, so a failing site or an over-eager relevance filter never looks like
  "no results". Turn any source off in Settings.
- **Built-in BitTorrent engine** (WebTorrent over TCP, with DHT and trackers): live progress, speed and peers;
  pause, resume, retry and delete (optionally with the files). Torrents that can't find peers fail after 3 minutes
  instead of sitting on "Fetching metadata" forever.
- **Series tasks** that check for the next episode on a schedule and download it. They understand `S01E05`, `1x05`,
  `Episode 5`, `Ep05` and anime-style `Show - 05`.
- **Stop or keep seeding** when a download finishes.
- **Notifications** by desktop (browser), e-mail (SMTP), push (ntfy) and Telegram.
- **Remote access** from any browser: sign in with Google, connect the computer once, link your phone with a QR code.
- **Agent access** (MCP and REST) for AI agents and scripts, off by default and loopback-only unless you add a TLS
  proxy and a bearer token.
- **Menu-bar (macOS) and notification-area (Windows) icon** with live download speed, active downloads and updates.
- **Start at login** on macOS and Windows.
- **Self-updating** from GitHub Releases, verified with a signature whose key is built into the app.
- **Eight languages**: English, Polish, German, French, Spanish, Italian, Portuguese and Russian.
- Secrets (SMTP password, bot token, agent and device tokens, browser keys) are **encrypted at rest**.

## Install

Download the file for your computer from the [latest release](https://github.com/XeonFX/MediaDownloader/releases/latest):

| Platform | File |
|---|---|
| macOS, Apple Silicon | `MediaDownloader-<version>-macos-arm64.zip` |
| macOS, Intel | `MediaDownloader-<version>-macos-x64.zip` |
| Windows | `MediaDownloader-<version>-windows-x64.exe` (or `-arm64`) |
| Linux | `MediaDownloader-<version>-linux-x64` (or `-arm64`) |

- **macOS:** unzip, move `MediaDownloader.app` to Applications and open it. Builds are ad-hoc signed, not notarized,
  so the first launch may need **System Settings → Privacy & Security → Open Anyway**. The app lives in the menu bar.
- **Windows:** run the `.exe`; it sits in the notification area. SmartScreen may ask you to confirm the first run.
- **Linux:** `chmod +x` the file and run it; the dashboard opens in your browser.

The dashboard is at <http://localhost:47820> (the next free port if that one is taken). Data lives in
`~/Library/Application Support/cc.codefusion.mediadownloader` (macOS), `%LOCALAPPDATA%\CodeFusion\MediaDownloader`
(Windows) or `~/.local/share/mediadownloader` (Linux); set `MD_DATA_DIRECTORY` to use another folder.

## Remote access

1. On the computer running MediaDownloader, open **Settings → Remote access** and choose **Connect to your account**.
2. A tab opens on mediadownloader.codefusion.cc. Sign in with Google and approve the device.
3. That browser is now linked. To add your phone, choose **Link a phone or another browser** (from the local
   dashboard or any linked browser) and scan the QR code while signed in to the same account.

Revoke a browser, rename the device or disconnect it from the same Settings section, or remove a device from the
website's device list. How the encryption works is described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#end-to-end-encryption).

## Upgrading from 1.x

Version 2 keeps its data separately, so 1.x keeps working. In **Settings → Import from the previous version**, import
your downloads, series tasks and settings. Downloads that were still in progress come in paused (so the two apps never
write the same files); resume them once you've quit 1.x. The SMTP password and Telegram bot token were encrypted with
keys only 1.x can read, so re-enter them. Private-tracker (PTE) downloads are not imported: PTE isn't supported in 2.x.

## Agent access (MCP and REST)

Enable **Settings → Agent access**, then point an MCP client at the URL shown there:

```bash
claude mcp add --transport http mediadownloader http://localhost:47820/mcp
```

The resolved URLs and bearer token are also written to `endpoint.json` in the data folder (owner-only). REST lives
under `/api`, described at `/openapi/v1.json`. Tools and routes: search (rate limited), details, start/pause/resume/
delete downloads, series-task CRUD with `PATCH` (partial) and `PUT` (complete) updates, "check now", and read-only
settings. Agent-chosen save folders must be inside the download folder, symlinks included, because an agent picks
arguments after reading untrusted torrent titles and descriptions.

Loopback requests need no token. Web pages can never call the API (cross-origin requests are refused, including after
DNS rebinding). Remote agents need **Allow access from other devices**, HTTPS through a TLS reverse proxy on the same
computer, and the bearer token.

## Development

Requires [Bun](https://bun.com) 1.4.

```bash
bun install
bun run dev:client        # the app on http://localhost:47820 (no tray, dev data in the normal folder unless MD_DATA_DIRECTORY is set)
bun run dev:web           # Vite on http://localhost:5173, proxying to the client (MD_WEB_TARGET=cloud proxies to the Worker)
bun run dev:worker        # the website on http://localhost:8790 with a local D1 and a passwordless dev sign-in
bun run check             # lint, typecheck, tests
bun run --cwd apps/client build [--target bun-windows-x64]   # a single executable in apps/client/dist
```

To try remote access locally, run the client with `MD_CLOUD_URL=http://localhost:8790` next to `dev:worker`.
`MD_LIVE_TESTS=1 bun test apps/client/test/live.test.ts` checks every provider against the real sites (also run
weekly in CI).

| Path | What it is |
|---|---|
| `packages/protocol` | The RPC contract shared by dashboard and device, the end-to-end encryption, relay framing, Worker API types |
| `apps/client` | The app: search providers, WebTorrent engine, series monitor, notifications, RPC/REST/MCP server, relay connector, tray, updater, legacy importer |
| `apps/web` | The React + Tailwind + daisyUI dashboard, served by the app locally and by the Worker remotely |
| `apps/worker` | The Cloudflare Worker: Google sign-in, pairing, device registry (D1) and the relay (a Durable Object per device) |
| `docs/` | [Architecture and security](docs/ARCHITECTURE.md), [deployment](docs/DEPLOY.md) |

### Releases

Bump `version` in `package.json`, merge, wait for CI on all three OSes, then tag: `git tag v2.1.0 && git push origin v2.1.0`.
The Release workflow builds every platform, writes `SHA256SUMS.txt`, signs it with the `RELEASE_SIGNING_KEY` secret
(created once with `bun scripts/release-key.ts`) and publishes the GitHub release.

## License

[MIT](LICENSE)
