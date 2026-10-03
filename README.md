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

Every feature with screenshots of the app, in all eight languages: [magnetar.codefusion.cc/features](https://magnetar.codefusion.cc/features).

- **Search six sources in parallel**, with results streamed in as each answers: The Pirate Bay (apibay API with HTML
  mirror fallback), 1337x (the real site where it answers, else a mirror; magnet and description fetched on demand),
  RARBG (TheRARBG's JSON API), Torrents-CSV, Nyaa and EZTV. A search can be linked (`/search/house+of+the+dragon?res=720p&source=tpb&sort=new`), and
  queries in any script match.
- **Per-source outcomes** above the results, so a failing site or an over-eager relevance filter never looks like
  "no results". Turn any source off in Settings.
- **Built-in BitTorrent engine** (librqbit, with DHT and trackers): live progress, speed and peers;
  pause, resume, retry and delete (optionally with the files). Restarts and pauses resume without re-reading what
  is already downloaded, and the peer port is forwarded on your router (UPnP). Torrents that can't find peers fail
  after 3 minutes instead of sitting on "Fetching metadata" forever. Updates pause active downloads only once the new
  version is downloaded and verified, and resume them when it starts; downloaded files are never touched.
- **Add anything:** magnet links (paste one or many, or click one anywhere once Magnetar is the system's
  handler) and `.torrent` files of up to 4 MB (pick, drop on the Downloads page, or open one), on this computer or
  through the website. The add dialog always shows what will start and where.
- **Choose files** of a torrent (skip the extras of a season pack), see each file's progress, and show a download
  in Finder or Explorer.
- **Play while downloading:** video and audio play in the browser, with the torrent's subtitles, fetching the
  parts you reach first. On the computer running the app a link works in VLC too; from the website, playback goes
  through the same end-to-end encrypted connection as everything else.
- **Files:** browse the download folder and folders you add on the computer, folders first with sizes and dates;
  play what came from a download, make folders, and choose the download folder, also from a phone. Only those
  folders can be seen, and only the computer itself adds one.
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
  Several computers on one account, with a switcher that keeps your page.
- **Agent access** (MCP and REST) for AI agents and scripts, off by default and loopback-only unless you add a TLS
  proxy and a bearer token.
- **Menu-bar (macOS) and notification-area (Windows) icon** with live download and upload totals, every unfinished download
  (pause or resume it, show it in Finder or Explorer), pause and resume all, slow mode and speed-limit presets, notification
  and Open at Login switches, remote access and updates. The open menu updates in place.
- **Start at login** on macOS and Windows.
- **Self-updating** from GitHub Releases, verified with a signature whose key is built into the app. A new version
  arrives as a system notification with an **Install** button (once per version), and **What's new** (Settings →
  About, the menu-bar icon, or magnetar.codefusion.cc/about) shows what each release brings.
- **Always know what runs:** the app (Settings → About, the menu-bar icon) and the website (its footer) show their
  version and commit, and the website flags any of your computers whose app is out of date, with one-click update.
- **Eight languages**: English, Polish, German, French, Spanish, Italian, Portuguese and Russian.
- Secrets (SMTP password, bot token, agent and device tokens, browser keys) are **encrypted at rest**.

## Install

Download the file for your computer from the [latest release](https://github.com/codefusion-cc/magnetar/releases/latest):

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

One account holds up to 20 computers. Each has a name of letters, digits and hyphens, unique on the account, which is
its address on the website: `magnetar.codefusion.cc/MacBook-Pro/search/dragon`. Renaming moves an open page to the new
address; links by id (`/d/<device id>/…`, as notifications use) always find the device under its current name. On the
website, the device's name at the bottom of the sidebar (at the top on
a phone) switches to another one and keeps the page you are on; each shows whether it is online and whether this
browser is linked to it. A computer's own dashboard links to the others once it is on an account.

Revoke a browser, rename the device or disconnect it from the same Settings section, or remove a device from the
website's device list. How the encryption works is described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#end-to-end-encryption).

## Coming from MediaDownloader

Magnetar keeps its data separately, so MediaDownloader keeps working. When Magnetar finds MediaDownloader data it
offers to import it on the Downloads page (and under **Settings → About**): your downloads, series tasks and settings.
Downloads that were still in progress come in paused (so the two apps never write the same files); resume them once
you've quit MediaDownloader. The SMTP password and Telegram bot token were encrypted with keys only MediaDownloader can
read, so re-enter them. Private-tracker (PTE) downloads are not imported: Magnetar doesn't support PTE.

## Agent access (MCP and REST)

On the computer running Magnetar, **Settings → AI agents → Connect an AI agent** lists the agents it finds and connects
one with a click, turning agent access on:

| Agent | How it is connected |
|---|---|
| Claude Code, Codex, Gemini CLI | Its own command (`claude mcp add …`, `codex mcp add …`, `gemini mcp add …`), for every project |
| Cursor, VS Code, Windsurf, OpenCode | An entry in its user settings file (`~/.cursor/mcp.json` and the like), other settings untouched and the original kept once as `*.before-magnetar` |
| Claude Desktop | `magnetar mcp` in its settings: the app as a stdio MCP server that relays to the running app, and starts it if needed |

A settings file that isn't plain JSON (comments, trailing commas) is left alone. Every agent, found or not, also has
**Set up by hand** with the exact command or JSON. From a terminal, for any other MCP client:

```bash
claude mcp add --transport http --scope user magnetar http://localhost:47820/mcp
```

The resolved URLs and bearer token are also written to `endpoint.json` in the data folder (owner-only). REST lives
under `/api`, described at `/openapi/v1.json`. Tools and routes: search (rate limited; a source by its name or its
short id, `tpb`, `1337x`, `nyaa`, `eztv`, `rarbg`, `torrents-csv`), details, start/pause/resume/delete downloads, series-task CRUD with `PATCH` (partial) and `PUT` (complete) updates, "check now", and read-only
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
npm run screenshots -w @magnetar/e2e   # the features page's screenshots, light and dark (--only=search,player); see below
```

The debug client serves the dashboard from `apps/web/dist`, so run `npm run build:web` once (or use `dev:web`). To try
remote access locally, run the client with `MAGNETAR_CLOUD_URL=http://localhost:8790` next to `dev:worker`.
`MAGNETAR_LIVE_TESTS=1 cargo test --test providers live_providers` checks every provider against the real sites (also run
weekly in CI).

The features page (`/features`, `/features/<language>`, the website's only) is `apps/web/src/features`: the outline of
groups, features and shots in `outline.ts`, the words of each language in `content/`, and the page itself from
[@codefusion-cc/features-page](https://www.npmjs.com/package/@codefusion-cc/features-page). Its screenshots are taken
by `apps/e2e/features/screenshots.ts` from the real app on fresh data: build the dashboard (`npm run build:web`) and the
app with a release's version (`MAGNETAR_VERSION=1.1.0 cargo build -p magnetar`), then run `npm run screenshots -w
@magnetar/e2e`. It starts the Worker and three copies of the app on ports 8797 and 47891–47893, downloads Blender's
open films and Linux images, and removes everything it made when it ends.

Worktrees share compiled crates through [sccache](https://github.com/mozilla/sccache), set up once per machine rather
than in the repository, so CI and other machines build without it: `brew install sccache` (or `cargo install sccache`),
then in `~/.cargo/config.toml`:

```toml
[build]
rustc-wrapper = "sccache"
```

A new worktree then takes its dependencies (Rust, and aws-lc's and SQLite's C) from the cache instead of compiling
them: 88% of its compiler calls hit, and `cargo test` plus `cargo clippy` finish about a third sooner. Only the
`magnetar` crate, the links and the build scripts run again. `sccache --show-stats` shows the hits; the cache keeps
10 GB by default (`SCCACHE_DIR` and `SCCACHE_CACHE_SIZE` move and resize it). Don't point worktrees at one shared
`CARGO_TARGET_DIR` instead: Cargo then treats every worktree's `magnetar` as the same unit and decides freshness by
file times, so a worktree whose sources are older than another's last build silently gets that build's binary, and
parallel builds wait on one lock.

| Path | What it is |
|---|---|
| `packages/protocol` | The RPC contract shared by dashboard and device, the end-to-end encryption, relay framing, Worker API types |
| `apps/client` | The app, in Rust: search providers, librqbit engine, series monitor, notifications, RPC/REST/MCP server, relay connector, tray, updater, legacy importer |
| `apps/web` | The React + Tailwind + daisyUI dashboard, served by the app locally and by the Worker remotely |
| `apps/worker` | The Cloudflare Worker: Google sign-in, pairing, device registry (D1), the relay (a Durable Object per device), Web Push forwarding and the latest-release lookup |
| `apps/e2e` | Playwright tests of the dashboard against the real app, and the features page's screenshots |
| `docs/` | [Architecture and security](docs/ARCHITECTURE.md), [deployment](docs/DEPLOY.md) |

### Releases

Every merge to `main` that changes the app is released automatically as the next patch version once CI is green: the
latest `vX.Y.Z` tag plus one (`scripts/release-version.ts`). Merges that change only docs, tests or CI files are not
released. The tag is the version: the executable is built with it and the website shows it, so neither reads a version
from `package.json` or `Cargo.toml` (they only name the first release and local builds). For a minor or major release
tag the merge by hand once CI is green: `git tag v2.1.0 && git push origin v2.1.0`; the next automatic patch continues
from it (v2.1.1). The Release workflow builds every platform, writes `SHA256SUMS.txt`, signs it with the `RELEASE_SIGNING_KEY` secret
(created once with `node scripts/release-key.ts`) and publishes the GitHub release, with notes written from the pull
requests merged since the last release and grouped by branch type (`feat/` New, `fix/` Fixes, `perf/` Faster; a PR
labeled `skip-changelog` stays out). The app's What's new shows these notes, so PR titles are written for users. A tag
with a pre-release (`v2.1.0-rc.1`) publishes a pre-release, which installed apps don't take. With the Apple and Windows
certificates as secrets (see [deployment](docs/DEPLOY.md#code-signing)) the builds are also code-signed and the macOS
app notarized.

## License

[MIT](LICENSE)
