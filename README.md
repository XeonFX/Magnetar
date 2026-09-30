# Magnetar

A torrent search-and-download manager that runs as **one self-contained executable** on your computer, with a
React dashboard you can open locally or from anywhere at **[magnetar.codefusion.cc](https://magnetar.codefusion.cc)**.
Remote access is **end-to-end encrypted**: the website relays data between your browser and your computer, but can't
read what you search for, what you download, or your settings.

> **Legal notice:** downloading copyrighted material without permission may be illegal where you live. Use this for
> content you are entitled to download (Linux ISOs, public-domain and Creative Commons media, your own files).

Magnetar succeeds the .NET/Blazor [MediaDownloader](https://github.com/XeonFX/MediaDownloader-legacy): the app is
Rust, the dashboard and website TypeScript. It can import everything from a MediaDownloader installation (see
[Coming from MediaDownloader](#coming-from-mediadownloader)).

## Features

- **Search six sources in parallel**, with results streamed in as each answers: The Pirate Bay (apibay API with HTML
  mirror fallback), 1337x (the real site where it answers, else a mirror; magnet and description fetched on demand),
  RARBG (TheRARBG's JSON API), Torrents-CSV, Nyaa and EZTV. A search can be linked (`/search?q=…`), and queries in any
  script match.
- **Per-source outcomes** above the results, so a failing site or an over-eager relevance filter never looks like
  "no results". Turn any source off in Settings.
- **Built-in BitTorrent engine** (librqbit, with DHT and trackers): live progress, speed and peers;
  pause, resume, retry and delete (optionally with the files). Restarts and pauses resume without re-reading what
  is already downloaded, and the peer port is forwarded on your router (UPnP). Torrents that can't find peers fail
  after 3 minutes instead of sitting on "Fetching metadata" forever. Updates pause active downloads only once the new
  version is downloaded and verified, and resume them when it starts; downloaded files are never touched.
- **Add anything:** magnet links (paste one or many, or click one anywhere once Magnetar is the system's
  handler) and `.torrent` files (pick, drop on the Downloads page, or open one). The add dialog always shows what
  will start and where.
- **Choose files** of a torrent (skip the extras of a season pack), see each file's progress, and show a download
  in Finder or Explorer.
- **Play while downloading:** video and audio play in the browser, with the torrent's subtitles, fetching the
  parts you reach first. On the computer running the app a link works in VLC too; from the website, playback goes
  through the same end-to-end encrypted connection as everything else.
- **Watchlist:** series tasks check for the next episode on a schedule and take the best release your rules allow
  (resolution, seeders, size, words to prefer or avoid), starting from an episode, the latest one, or new ones only.
  A release with no seeders is replaced by the next best. Posters, networks and air dates come from TVmaze. Watches
  wait for a release of anything else (a film in 4K) and tell you, or download it, when one appears.
- **Speed limits** with alternative limits switched by hand or on a schedule; **seed** to a ratio, or stop or keep
  seeding when a download finishes; free space shown on the Downloads page.
- **VPN kill switch** (macOS and Linux): bind torrent traffic to one network interface, and nothing moves without it.
- **Notifications** by desktop (browser), e-mail (SMTP), push (ntfy), Telegram, and **browser push**: a linked phone
  or browser gets them with the website closed, encrypted on the computer for that browser.
- **Installable website** (a Progressive Web App) with a download button for your system.
- **Remote access** from any browser: sign in with Google, connect the computer once, link your phone with a QR code.
- **Agent access** (MCP and REST) for AI agents and scripts, off by default and loopback-only unless you add a TLS
  proxy and a bearer token.
- **Menu-bar (macOS) and notification-area (Windows) icon** with live download speed, active downloads and updates.
- **Start at login** on macOS and Windows.
- **Self-updating** from GitHub Releases, verified with a signature whose key is built into the app.
- **Eight languages**: English, Polish, German, French, Spanish, Italian, Portuguese and Russian.
- Secrets (SMTP password, bot token, agent and device tokens, browser keys) are **encrypted at rest**.

## Install

Download the file for your computer from the [latest release](https://github.com/XeonFX/Magnetar/releases/latest):

| Platform | File |
|---|---|
| macOS, Apple Silicon | `Magnetar-<version>-macos-arm64.zip` |
| macOS, Intel | `Magnetar-<version>-macos-x64.zip` |
| Windows | `Magnetar-<version>-windows-x64.exe` (or `-arm64`) |
| Linux | `Magnetar-<version>-linux-x64` (or `-arm64`) |

- **macOS:** unzip, move `Magnetar.app` to Applications and open it. Releases built without the Developer ID
  certificate are ad-hoc signed, so the first launch may need **System Settings → Privacy & Security → Open Anyway**.
  The app lives in the menu bar.
- **Windows:** run the `.exe`; it sits in the notification area. SmartScreen may ask you to confirm the first run.
- **Linux:** `chmod +x` the file and run it; the dashboard opens in your browser.

The dashboard is at <http://localhost:47820> (the next free port if that one is taken). Data lives in
`~/Library/Application Support/cc.codefusion.magnetar` (macOS), `%LOCALAPPDATA%\CodeFusion\Magnetar`
(Windows) or `~/.local/share/magnetar` (Linux); set `MAGNETAR_DATA_DIRECTORY` to use another folder, and
`MAGNETAR_DOWNLOAD_FOLDER` for another default download folder than `~/Downloads/Magnetar`.

## Remote access

1. On the computer running Magnetar, open **Settings → Remote access** and choose **Connect to your account**.
2. A tab opens on magnetar.codefusion.cc. Sign in with Google and approve the device.
3. That browser is now linked. To add your phone, choose **Link a phone or another browser** (from the local
   dashboard or any linked browser) and scan the QR code while signed in to the same account.

Revoke a browser, rename the device or disconnect it from the same Settings section, or remove a device from the
website's device list. How the encryption works is described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#end-to-end-encryption).

## Coming from MediaDownloader

Magnetar keeps its data separately, so MediaDownloader keeps working. When Magnetar finds MediaDownloader data it
offers to import it on the Downloads page (and under **Settings → About**): your downloads, series tasks and settings.
Downloads that were still in progress come in paused (so the two apps never write the same files); resume them once
you've quit MediaDownloader. The SMTP password and Telegram bot token were encrypted with keys only MediaDownloader can
read, so re-enter them. Private-tracker (PTE) downloads are not imported: Magnetar doesn't support PTE.

## Agent access (MCP and REST)

On the computer running Magnetar, **Settings → AI agents → Connect Claude** turns agent access on and adds
the server to Claude Code (for every project). Other MCP clients, or Claude Code where the app can't find it, use the URL
shown there:

```bash
claude mcp add --transport http --scope user magnetar http://localhost:47820/mcp
```

The resolved URLs and bearer token are also written to `endpoint.json` in the data folder (owner-only). REST lives
under `/api`, described at `/openapi/v1.json`. Tools and routes: search (rate limited), details, start/pause/resume/
delete downloads, series-task CRUD with `PATCH` (partial) and `PUT` (complete) updates, "check now", and read-only
settings. Agent-chosen save folders must be inside the download folder, symlinks included, because an agent picks
arguments after reading untrusted torrent titles and descriptions.

Loopback requests need no token. Web pages can never call the API (cross-origin requests are refused, including after
DNS rebinding). Remote agents need **Allow access from other devices**, HTTPS through a TLS reverse proxy on the same
computer, and the bearer token. Whatever comes through the proxy counts as remote, even from this computer.

## Development

Requires [Node.js](https://nodejs.org) 24 with npm 11, and a stable [Rust](https://rustup.rs) toolchain.

```bash
npm install
npm run dev:client        # the app on http://localhost:47820 (cargo run; no tray, dev data in the normal folder unless MAGNETAR_DATA_DIRECTORY is set)
npm run dev:web           # Vite on http://localhost:5173, proxying to the client (MAGNETAR_WEB_TARGET=cloud proxies to the Worker)
npm run dev:worker        # the website on http://localhost:8790 with a local D1 and a passwordless dev sign-in
npm run check             # oxlint, clippy, rustfmt, tsc, Vitest (the Worker's tests in workerd) and cargo test
npm run e2e               # Playwright drives the real app (its own data and download folders) through the dashboard
npm run build:client      # the dashboard and a release executable in apps/client/dist (--target <rust triple> for another platform)
```

The debug client serves the dashboard from `apps/web/dist`, so run `npm run build:web` once (or use `dev:web`). To try
remote access locally, run the client with `MAGNETAR_CLOUD_URL=http://localhost:8790` next to `dev:worker`.
`MAGNETAR_LIVE_TESTS=1 cargo test --test providers live_providers` checks every provider against the real sites (also run
weekly in CI).

| Path | What it is |
|---|---|
| `packages/protocol` | The RPC contract shared by dashboard and device, the end-to-end encryption, relay framing, Worker API types |
| `apps/client` | The app, in Rust: search providers, librqbit engine, series monitor, notifications, RPC/REST/MCP server, relay connector, tray, updater, legacy importer |
| `apps/web` | The React + Tailwind + daisyUI dashboard, served by the app locally and by the Worker remotely |
| `apps/worker` | The Cloudflare Worker: Google sign-in, pairing, device registry (D1), the relay (a Durable Object per device), Web Push forwarding and the latest-release lookup |
| `apps/e2e` | Playwright tests of the dashboard against the real app |
| `docs/` | [Architecture and security](docs/ARCHITECTURE.md), [deployment](docs/DEPLOY.md) |

### Releases

Bump `version` in `package.json`, merge, wait for CI on all three OSes, then tag: `git tag v2.1.0 && git push origin v2.1.0`.
The Release workflow builds every platform, writes `SHA256SUMS.txt`, signs it with the `RELEASE_SIGNING_KEY` secret
(created once with `node scripts/release-key.ts`) and publishes the GitHub release. With the Apple and Windows
certificates as secrets (see [deployment](docs/DEPLOY.md#code-signing)) the builds are also code-signed and the macOS
app notarized.

## License

[MIT](LICENSE)
