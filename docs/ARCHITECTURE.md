# Architecture and security

```
 phone / laptop browser                mediadownloader.codefusion.cc                 your computer
┌──────────────────────┐   HTTPS    ┌──────────────────────────────────┐   WSS    ┌───────────────────────┐
│ React dashboard      │──cookie───►│ Worker: sign-in, pairing, D1     │◄─token───│ MediaDownloader (Bun) │
│ key in IndexedDB     │            │ DeviceRelay DO (one per device)  │          │ engine, providers, …  │
│                      │◄═══════════╪══ sealed frames, relayed as-is ══╪═════════►│ browser keys (sealed) │
└──────────────────────┘            └──────────────────────────────────┘          └───────────────────────┘
                                                                                    ▲ localhost:47820
                                                                        local dashboard, same React build
```

## One dashboard, two transports

`apps/web` is a single build. It asks `/app-config.json` where it is running: the app answers `local`, the Worker
answers `cloud`. Every page talks to a device through an `RpcClient`:

- **LocalConnection**: a same-origin WebSocket to `/ws` on the app. The app accepts it only from a loopback address,
  under a loopback host name, with the app's own `Origin`, so neither web pages nor DNS-rebound sites can drive it.
- **RelayConnection**: a WebSocket to the Worker, which forwards to the device's relay. Everything after the
  handshake is sealed end to end.

Both carry the same messages, defined once in `packages/protocol/src/rpc.ts`: `{ id, method, params }` calls,
`{ id, result | error }` replies, and `{ event, data }` pushes (download progress, streamed search results, settings
changes, desktop notifications). The app validates every call against a zod schema, and the REST and MCP surfaces go
through the same `Actions` facade, so the three surfaces cannot drift apart.

## Pairing

1. The local dashboard asks the app to pair. The app calls `POST /api/pair/start` and receives a pairing id and a
   poll secret. It also mints a **browser key** (below), inactive for now, and opens
   `https://mediadownloader.codefusion.cc/pair/<pairingId>#i=<keyId>&k=<key>`.
2. The website parks the key from the fragment in session storage, has you sign in, and shows the device name.
   Approving creates the device in D1 with a fresh random token, stored only as a hash.
3. The app polls `POST /api/pair/poll` with the poll secret, collects the token (handed over once, then deleted),
   activates the pending key and connects to the relay. The browser stores its key under the new device id.

Anyone who got hold of the pairing link before you could approve it into their own account. That is why the app shows
which account it was connected to, and you can disconnect it at any time.

## End-to-end encryption

The relay must not be able to read or alter anything a dashboard and a device say to each other.

**Browser keys.** For each linked browser the device mints 32 random bytes, K. K only ever leaves the device in a URL
fragment (`#…`), which browsers never send to servers: in the pairing link, or in the QR code / link made by
**Link a phone or another browser**. The browser imports K as a *non-extractable* HMAC key and keeps it in
IndexedDB, so page script can use it but not read it back. The device keeps every K sealed at rest and can revoke
each one.

**Handshake** (per connection, `packages/protocol/src/e2e.ts`):

```
browser → device   hello   { kid, eB, nB }            eB: ephemeral P-256 public key, nB: 16 random bytes
device             looks up K by kid; ephemeral eD, nonce nD
                   th   = SHA-256("md-e2e-v1" ‖ kid ‖ eB ‖ nB ‖ eD ‖ nD)
                   salt = HMAC-SHA256(K, th)
                   okm  = HKDF-SHA256(ECDH(eD, eB), salt, "md-e2e-v1 keys", 96 bytes)
                   k_b→d, k_d→b, k_confirm = okm[0:32], okm[32:64], okm[64:96]
device → browser   welcome { eD, nD, confirm = HMAC(k_confirm, "device" ‖ th) }
browser            derives the same keys and checks confirm
```

A relay that swaps either ephemeral key can't produce the salt without K, so the confirmation and every later frame
fail. Fresh ephemeral keys per connection give forward secrecy: a K stolen later doesn't decrypt recorded traffic.

**Frames**: AES-256-GCM with one key per direction. The IV is a direction tag plus a 64-bit counter, and the
associated data is `th`. The receiver requires exactly the next counter, which rejects replays, drops and
reordering. Any failure closes the connection. Sealing and opening are serialized, so frames stay in counter order
even though WebCrypto is asynchronous.

**What the relay still learns**: which account owns which device, when a dashboard is connected, and the sizes and
timing of frames. The device's name and platform are stored in D1 to show the device list.

**The website's own code** is the trust root for the remote dashboard, as with any web app: whoever controls the
deployed JavaScript could exfiltrate what the page decrypts. The device's key store and the non-extractable browser
keys limit what a compromised page could take away.

## Relay

`DeviceRelay` (`apps/worker/src/relay.ts`) is a Durable Object per device using the WebSocket Hibernation API. The
device socket is tagged `device`, each browser `browser` plus `b:<connectionId>`. Browser frames go to the device
prefixed with the 16-byte connection id; device frames are unwrapped and sent to that browser. Text frames are relay
control (`open`, `close`, device online/offline, `revoked`). Pings are answered with an auto-response, without waking
the object. Removing a device closes the device socket with 4001 and browsers with 4003.

## Accounts and sessions

Google sign-in is an OpenID Connect redirect (`response_type=id_token`, `response_mode=fragment`), adapted from
HeyHubs: the page draws its own button (no Google script on our pages), the Worker's callback page bounces the token
back to `/login` in the fragment, and the Worker verifies it: RS256 against Google's keys, issuer, audience (our client
id), expiry, verified e-mail, and a nonce bound to the browser with a short-lived `__Host-` cookie. Sessions are random
tokens in an `HttpOnly; Secure; SameSite=Lax` `__Host-` cookie, stored in D1 as SHA-256 hashes with a 30-day sliding
expiry. Cookie-authenticated calls and WebSocket upgrades must carry our own `Origin`.

## The app

`apps/client/src/app.ts` wires the services together:

- **Search**: `providers/*` parse each site (cheerio for HTML), `MirrorRotator` staggers mirror attempts (1.5 s)
  and remembers the fastest, `SearchService` fans out and reports per-source outcomes, `SearchResultCache` hands out
  30-minute result ids.
- **Downloads**: `DownloadManager` over a `TorrentEngine` (WebTorrent). Metadata is cached as `.torrent` files for
  quick re-attach; DHT nodes are remembered between runs. WebTorrent's WebRTC dependency is replaced by a stub at build
  time (`stub-webrtc.ts`), so no native code is needed. The DHT bootstraps from `dht.libtorrent.org` first: on some
  filtered networks the classic routers answer with one node repeated, which stalls the lookup.
- **Series**: `SeriesMonitor` checks due tasks every minute and saves after each queued episode.
- **Storage**: `bun:sqlite` with numbered migrations (`db/database.ts`); settings as one JSON row, so a new setting
  needs no migration; secrets sealed with AES-256-GCM under a key file beside the database (`db/secrets.ts`).
- **Tray**: AppKit (`NSStatusItem`) and Win32 (`Shell_NotifyIconW`) through `bun:ffi`, with events pumped from a timer
  on the JS thread. No helper binary.
- **Updates**: GitHub Releases every 6 hours. Installs require `SHA256SUMS.txt.sig`, an Ed25519 signature checked
  against the public key compiled into the app. macOS swaps the `.app` bundle after exit with rollback; Windows and
  Linux rename the running executable aside.
- **Telemetry**: logged errors are scrubbed (quoted text, paths, URLs, addresses, hashes, tokens) and sent, at most
  10 an hour, to the Worker, which forwards them to CodeFusion Console. Off in development; switchable in Settings.
