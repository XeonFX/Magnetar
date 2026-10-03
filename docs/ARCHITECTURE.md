# Architecture and security

```
 phone / laptop browser                magnetar.codefusion.cc                 your computer
┌──────────────────────┐   HTTPS    ┌──────────────────────────────────┐   WSS    ┌───────────────────────┐
│ React dashboard      │──cookie───►│ Worker: sign-in, pairing, D1     │◄─token───│ Magnetar (Rust)│
│ key in IndexedDB     │            │ DeviceRelay DO (one per device)  │          │ engine, providers, …  │
│                      │◄═══════════╪══ sealed frames, relayed as-is ══╪═════════►│ browser keys (sealed) │
└──────────────────────┘            └──────────────────────────────────┘          └───────────────────────┘
                                                                                    ▲ localhost:47820
                                                                        local dashboard, same React build
```

## One dashboard, two transports

`apps/web` is a single build. It asks `/app-config.json` where it is running: the app answers `local`, the Worker
answers `cloud`. On the website a device's pages are `/<device name>/…` (`/d/<device id>/…` moves there), and the
Worker answers page paths itself with the dashboard's one page (`serveSinglePageApp` from `@codefusion-cc/workers-http`):
single-page-application assets would redirect a path to their own spelling, turning a search's `+` into `%2B`, so the
assets keep the default `not_found_handling` and serve files only. Every page talks to a device through an `RpcClient`:

- **LocalConnection**: a same-origin WebSocket to `/ws` on the app. The app accepts it only from a loopback address,
  under a loopback host name, with the app's own `Origin`, so neither web pages nor DNS-rebound sites can drive it.
- **RelayConnection**: a WebSocket to the Worker, which forwards to the device's relay. Everything after the
  handshake is sealed end to end.

Both carry the same messages, defined once in `packages/protocol/src/rpc.ts`: `{ id, method, params }` calls,
`{ id, result | error }` replies, and `{ event, data }` pushes (download progress, streamed search results, settings
changes, desktop notifications). The dashboard's side is typed with zod; the app mirrors the contract as serde types
(`apps/client/src/protocol`) and validates every call against them. The REST and MCP surfaces go through the same
`Actions` facade as the dashboard (`apps/client/src/api/actions.rs`), so the three surfaces cannot drift apart.

## Pairing

1. The local dashboard asks the app to pair. The app calls `POST /api/pair/start` and receives a pairing id and a
   poll secret. It also mints a **browser key** (below), inactive for now, and opens
   `https://magnetar.codefusion.cc/pair/<pairingId>#i=<keyId>&k=<key>`.
2. The website parks the key from the fragment in session storage, has you sign in, and shows the device name.
   Approving creates the device in D1 with a fresh random token, stored only as a hash, under a name unique on the
   account (`MacBook-Pro`, else `MacBook-Pro-2`): the name is the device's address, `/<name>/…`
   (`packages/protocol/src/deviceName.ts`, a unique index in D1).
3. The app polls `POST /api/pair/poll` with the poll secret, collects the token (handed over once, then deleted) and
   its name, activates the pending key and connects to the relay. The browser stores its key under the new device id,
   so a rename never unlinks it.

Anyone who got hold of the pairing link before you could approve it into their own account. That is why the app shows
which account it was connected to, and you can disconnect it at any time.

## End-to-end encryption

The relay must not be able to read or alter anything a dashboard and a device say to each other.

**Browser keys.** For each linked browser the device mints 32 random bytes, K. K only ever leaves the device in a URL
fragment (`#…`), which browsers never send to servers: in the pairing link, or in the QR code / link made by
**Link a phone or another browser**. The browser imports K as a *non-extractable* HMAC key and keeps it in
IndexedDB, so page script can use it but not read it back. The device keeps every K sealed at rest and can revoke
each one. A K made for a link stops working if no browser connects with it within 10 minutes; a browser's first
connection tells every dashboard (`remote.changed`), which is how the dialog showing the link knows to close.

**Handshake** (per connection; the browser side is `packages/protocol/src/e2e.ts`, the device side
`apps/client/src/protocol/e2e.rs`, and both are checked against the same fixed vector,
`packages/protocol/src/e2e-vector.json`):

```
browser → device   hello   { kid, eB, nB }            eB: ephemeral P-256 public key, nB: 16 random bytes
device             looks up K by kid; ephemeral eD, nonce nD
                   th   = SHA-256("magnetar-e2e-v1" ‖ kid ‖ eB ‖ nB ‖ eD ‖ nD)
                   salt = HMAC-SHA256(K, th)
                   okm  = HKDF-SHA256(ECDH(eD, eB), salt, "magnetar-e2e-v1 keys", 96 bytes)
                   k_b→d, k_d→b, k_confirm = okm[0:32], okm[32:64], okm[64:96]
device → browser   welcome { eD, nD, confirm = HMAC(k_confirm, "device" ‖ th) }
browser            derives the same keys and checks confirm
```

A relay that swaps either ephemeral key can't produce the salt without K, so the confirmation and every later frame
fail. Fresh ephemeral keys per connection give forward secrecy: a K stolen later doesn't decrypt recorded traffic.

**Frames**: AES-256-GCM with one key per direction. The IV is a direction tag plus a 64-bit counter, and the
associated data is `th`. The receiver requires exactly the next counter, which rejects replays, drops and
reordering. Any failure closes the connection. Each end seals and opens in order: the browser serializes its
asynchronous WebCrypto calls, and the device opens frames on the relay socket's read loop and seals replies on one
task per connection.

**What the relay still learns**: which account owns which device, when a dashboard is connected, and the sizes and
timing of frames. The device's name and platform are stored in D1 to show the device list.

**The website's own code** is the trust root for the remote dashboard, as with any web app: whoever controls the
deployed JavaScript could exfiltrate what the page decrypts. The device's key store and the non-extractable browser
keys limit what a compromised page could take away.

## Relay

`DeviceRelay` (`apps/worker/src/relay.ts`) is a Durable Object per device using the WebSocket Hibernation API. The
device socket is tagged `device`, each browser `browser` plus `b:<connectionId>`. Browser frames go to the device
prefixed with the 16-byte connection id; device frames are unwrapped and sent to that browser. Text frames are relay
control (`open`, `close`, device online/offline, `revoked`, and `name` when the app says hello with another name than
the account's). Pings are answered with an auto-response, without waking
the object. Removing a device closes the device socket with 4001 and browsers with 4003.

A browser socket is bound to the account session that opened it (the session hash in its attachment). Signing out
closes that session's browser sockets on every device of the account, and signing an account out everywhere (the
console's `sign-out`) closes all of them, with 4004; the devices stay paired and are told `close` for each. An alarm
checks the sessions of open browser sockets in D1 every hour, so an expired or otherwise ended session closes too. A
browser without a session that asks to connect is answered the same way, with 4004 instead of an HTTP 401. The page
stops retrying on 4003 and 4004.

## Accounts and sessions

Google sign-in is an OpenID Connect redirect (`response_type=id_token`, `response_mode=fragment`) from
`@codefusion-cc/google-sign-in`, shared with HeyHubs: the page draws its own button (no Google script on our pages),
the Worker's callback page bounces the token back to `/login` in the fragment, and the Worker verifies it: RS256
against Google's keys, issuer, audience (our client id), expiry and time of issue, verified e-mail, and a nonce bound
to the browser with a short-lived `__Host-` cookie that each attempt spends. When Google's keys cannot be read the
Worker answers 503 and the page asks the person to try again in a minute. Sessions are random
tokens in an `HttpOnly; Secure; SameSite=Lax` `__Host-` cookie, stored in D1 as SHA-256 hashes (base64url) with a
30-day sliding expiry. Cookie-authenticated calls and WebSocket upgrades must carry our own `Origin` (or, without one,
`Sec-Fetch-Site: same-origin`).

The Worker's request plumbing comes from `@codefusion-cc/workers-http`: JSON bodies must be JSON objects of at most
16 KiB, counted as they are read (`MAX_BODY` in `env.ts`); rate limits count a client's address, an IPv6 address by
its whole /64; and anything a handler throws becomes a JSON answer with the same headers as any other.

## CodeFusion Console

magnetar.codefusion.cc is one of CodeFusion Console's apps (`@codefusion-cc/console`):

- **Accounts and devices**: the console reads them through the Worker's `ConsoleAdmin` entrypoint, over its service
  binding only (`apps/worker/src/console/`). Members who may moderate sign an account out everywhere or remove
  devices, the same way their owners would; deleting an account needs `records:manage` and a reason. Emails, names
  and device names are personal: the console shows them only to members with `pii:read`, and the Worker refuses to
  search by them for anyone else.
- **Failures**: the Worker's own (the console tails it), the website's (`/api/browser-failures`, masked first with the
  same `scrub` as the app's, then by the package) and the desktop app's (`/api/telemetry/failure`, below).
- **Visits**: page views by screen name (`packages/protocol/src/consolePages.ts`), without a visitor id: nobody is
  asked for statistics consent, so nothing is stored in the browser.
- **Deployments**: every merge to `main` deploys the Worker (docs/DEPLOY.md); the console reads the build's
  `version.json` and the deploy job's GitHub deployment. Open pages move onto a newer deploy through `@codefusion-cc/app-update`
  (on a device's own dashboard, after the app updates), without cutting short anything being typed or saved.

## The app

A Rust program built into one executable (`apps/client`), with the dashboard embedded by `rust-embed` in release
builds (debug builds read `apps/web/dist` from disk). `src/app.rs` wires the services together on a Tokio runtime:

- **Search**: `search/providers/*` parse each site (`scraper` for HTML), `MirrorRotator` starts the next mirror when
  one fails or hasn't answered within 1.5 s and remembers the fastest, `SearchService` fans out and reports per-source
  outcomes, `SearchResultCache` hands out 30-minute result ids.
- **Downloads**: `DownloadManager` over librqbit (`downloads/engine.rs`). A magnet's metadata is fetched first and
  cached as a `.torrent` file; a torrent with no peers fails after 3 minutes. librqbit keeps its own torrent list in
  `session/` with each torrent's verified pieces (fast resume), so pausing and restarting never re-read the files; at
  start the manager reconciles that list with the database, which stays the source of truth (`Engine::reconcile`).
  Pausing and removing run in the background; until one is done the torrent counts as leaving, so adding it again
  waits for it and its piece counts, possibly from before the last stop, are not read.
  The peer port is forwarded with UPnP. Multi-file torrents get a folder of their own inside the save folder. Deleting files goes through the
  torrent's own file list and never removes the save folder itself. The DHT bootstraps from `dht.libtorrent.org`
  first (on some filtered networks the classic routers answer with one node repeated, which stalls the lookup) and its
  routing table is kept in `dht.json` between runs.
  The engine runs under a supervisor (`DownloadManager::supervise_engine`): it starts the engine, applies the speed
  caps of the moment (usual or alternative, `downloads/transfer.rs`) when they change, and restarts the engine when
  the chosen network interface changes. With an interface chosen, every socket is bound to it and the engine only
  runs while it exists: when a VPN drops, downloads wait, queued. Progress goes out as `downloads.updated` with only
  the rows whose numbers changed; `downloads.changed` carries the whole list on structural changes.
- **Playback**: a file is read from disk once complete, else through librqbit's `FileStream`, which fetches the
  pieces the reader reaches first (`downloads/media.rs`). Complete means every piece verified: librqbit sets a file to
  its full length when the torrent starts, so the size on disk says nothing. Per-file progress comes from the engine,
  from the pieces it saved in `session/<hash>.bitv` while a download is paused, or from a finished download's state.
  Locally `/stream/<token>` serves byte ranges; a token is handed out over the dashboard socket for one file and 12
  hours. Remotely the website's service worker (`sw.js`)
  answers the player's range requests with bytes the page reads by `stream.read` over the encrypted channel (at
  most 448 KiB a read, to stay under the relay's frame size).
- **Series and watches**: `SeriesMonitor` checks due series tasks and watches every minute. Each episode takes the
  best release its task's quality rules allow (`series/quality.rs`); a download that found no peers is replaced by the
  next best and its release remembered in `series_rejects`. Tasks can start from the newest episode already out.
  Show details and posters come from TVmaze (`series/tvmaze.rs`), refreshed twice a day, posters served to browsers
  by `series.poster`. A watch reports (or downloads) the first release its rules allow, then rests.
- **Browser push**: a linked browser subscribes with the Worker's VAPID public key and gives the subscription to the
  device over the encrypted channel (`push_subscriptions`, removed with the browser's key). Each notification is
  sealed on the device for that subscription (RFC 8291, `protocol/webpush.rs`) and posted to the Worker, which adds
  the VAPID signature and forwards the ciphertext to the push service (`@codefusion-cc/web-push`). Both only send to the browsers' push
  services. A 404 or 410 drops the subscription.
- **Adding .torrent files from the dashboard**: a call may be at most 1 MiB on either transport (the relay's frame,
  `MAX_RELAY_FRAME`; the app's own socket takes the same), and the dashboard refuses a larger one before sending it.
  A .torrent file of up to 512 KiB goes whole in `downloads.start`; a larger one, up to the 4 MiB limit, in 512 KiB
  `downloads.upload` pieces, each its own sealed call, then `downloads.startUpload`
  (`packages/protocol/src/torrentUpload.ts`). The app keeps pieces per connection (`downloads/upload.rs`), at most
  two files at once, drops a file whose pieces arrive out of order or short, and lets them go when the connection
  closes.
- **Opening magnet links and .torrent files**: the macOS bundle declares both and becomes the default through Launch
  Services; Windows registers per-user classes, Linux a desktop entry set with xdg-mime (`system/handlers.rs`). The
  app, or the running instance, opens the dashboard at `/?add=…` or `/?torrent=…`, which fills in the add dialog.
- **Storage**: SQLite (`rusqlite`, bundled) with numbered migrations (`db.rs`); settings as one JSON row, so a new
  setting needs no migration; secrets sealed with AES-256-GCM under a key file beside the database.
- **Server**: `axum` on localhost (IPv4 and IPv6) serves the dashboard, its WebSocket, the agent REST API
  (`http/rest.rs`) and a stateless MCP endpoint (`http/mcp.rs`, JSON-RPC over Streamable HTTP). `magnetar mcp`
  (`bridge.rs`) is the same server on stdio for agents that only start local servers: it reads the running app's
  address from `endpoint.json` for every message and relays. `system/agents.rs` connects agents on this computer,
  through their own command or by editing their settings file.
- **Tray**: `tray-icon` on a `tao` event loop on the main thread (macOS menu bar, Windows notification area). Linux
  has no tray; the dashboard opens in the browser. A background task reads the app each second (or right after a menu
  command) and describes the menu as rows (`tray.rs`); the main thread only applies them. While their shape (kinds,
  commands, nesting) stays the same the native items are updated in place, so an open menu keeps ticking instead of
  closing on a rebuild. Pause all and resume all are `Actions`, like every other download control.
- **Updates**: GitHub Releases every 6 hours (the newest 20, with an ETag so an unchanged list costs no rate limit),
  compared as Semantic Versioning (`updates/version.rs`, the same rules as `@codefusion-cc/app-update` on the web
  side: pre-releases come before their release and are never offered, a dev build's `+dev` changes nothing). A new
  version is told once, also across restarts (`kv` `updates.notified_version`): through the notification channels,
  and as an OS notification with an Install button (`system/notify.rs`: UserNotifications on macOS, falling back to
  NSUserNotification for an ad-hoc signed build, a toast on Windows, `notify-send` on Linux). The releases' notes
  answer `updates.releases`, the dashboard's changelog. Installs require `SHA256SUMS.txt.sig`, an Ed25519 signature checked
  against the public key compiled into the app. macOS swaps the `.app` bundle after exit with rollback
  (`updates/mac-install.sh`); Windows and Linux rename the running executable aside. The new version is downloaded
  and verified first; only then are active downloads paused (their ids kept under `downloads.pausedForUpdate`) and
  the app swapped. The next start resumes exactly those, or this one does if the swap fails.
- **Telemetry**: logged errors are scrubbed (quoted text, paths, URLs, addresses, hashes, tokens) and sent, at most
  10 an hour, to the Worker, which forwards them to CodeFusion Console. Off in development; switchable in Settings.
  What the computer's surroundings cause (`log::SURROUNDINGS`: dropped connections, full disks) is logged as a warning
  and not sent: Magnetar's own errors through `log_failure!`, by their type; librqbit's by their text.
