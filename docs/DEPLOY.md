# Deploying magnetar.codefusion.cc

The Worker in `apps/worker` serves the website, sign-in, pairing and the relay. One-time setup, then `npm run deploy -w @magnetar/worker`.

## 1. Google OAuth client

Google Cloud Console → **APIs & Services → Credentials → Create credentials → OAuth client ID**:

- Application type: **Web application**, name `Magnetar`
- Authorized JavaScript origins: `https://magnetar.codefusion.cc`
- Authorized redirect URIs: `https://magnetar.codefusion.cc/api/auth/google/callback`

The consent screen needs only the `openid`, `email` and `profile` scopes. Put the client id in
`apps/worker/wrangler.jsonc` → `vars.GOOGLE_CLIENT_ID`. It is public; no client secret is used.

## 2. D1 database

The production database `magnetar` exists and its id is in `wrangler.jsonc`. A new migration goes out with:

```bash
npm run migrate:remote -w @magnetar/worker
```

## 3. CodeFusion Console

The console (XeonFX/codefusion-console) lists Magnetar in `config/apps.json` and binds `MAGNETAR_ADMIN` to this
Worker's `ConsoleAdmin` entrypoint. Deploy this Worker first, so the console's deploy binds a service that exists.
Its Deployments page reads this repository with the console's GitHub token, which must include XeonFX/Magnetar.

## 4. Deploy

```bash
npm run deploy -w @magnetar/worker
```

This builds the dashboard and deploys the Worker, its assets and the `DeviceRelay` Durable Object. The custom domain
route creates the DNS record in the `codefusion.cc` zone.

## Release signing

Once, from the repo root:

```bash
node scripts/release-key.ts
```

Commit `apps/client/release-public-key.txt` and save the printed private key as the repository secret
`RELEASE_SIGNING_KEY`. Keep no other copy: losing it means shipping a release with a new public key, which older
installs will not auto-install (they fall back to opening the release page).

## Code signing

Optional: without these secrets releases are ad-hoc signed (macOS asks users to confirm the first launch, Windows
SmartScreen warns).

| Secret | What it is |
|---|---|
| `MACOS_CERTIFICATE` | The Developer ID Application certificate and key, exported as .p12, base64 |
| `MACOS_CERTIFICATE_PASSWORD` | The .p12's password |
| `MACOS_SIGNING_IDENTITY` | Its name, e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD` | For notarization; the password is an app-specific password from appleid.apple.com |
| `WINDOWS_CERTIFICATE` | A code-signing certificate as .pfx, base64 |
| `WINDOWS_CERTIFICATE_PASSWORD` | The .pfx's password |

The macOS bundle is signed with the hardened runtime, notarized, stapled and checked with `spctl` before it is
zipped. Changing from ad-hoc to Developer ID signing is fine for updates: the updater checks the bundle identifier,
and Gatekeeper only once the installed app is itself certificate-signed.

## Browser notifications (Web Push)

Once, from `apps/worker`: `npx -p @codefusion-cc/web-push codefusion-vapid | npx wrangler secret put VAPID_PRIVATE_KEY`.
The Worker derives the public key browsers subscribe with. For `wrangler dev`, put the printed key in
`apps/worker/.dev.vars` as `VAPID_PRIVATE_KEY='…'`. Without it the website doesn't offer browser notifications. A new
key makes every browser subscribe again.

## Downloads on the website

The sign-in page and an empty device list offer the app for the visitor's system, from the latest GitHub release of
`RELEASES_REPO` (a Worker var, `XeonFX/Magnetar` by default). Asset names must stay
`Magnetar-<version>-<macos|windows|linux>-<arm64|x64>[.zip|.exe]`.
