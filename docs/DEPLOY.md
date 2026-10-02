# Deploying magnetar.codefusion.cc

The Worker in `apps/worker` serves the website, sign-in, pairing and the relay. After the one-time setup below, every
merge to `main` deploys it: the CI workflow's **Deploy magnetar.codefusion.cc** job runs once every check has passed.

## 1. Google OAuth client

Google Cloud Console → **APIs & Services → Credentials → Create credentials → OAuth client ID**:

- Application type: **Web application**, name `Magnetar`
- Authorized JavaScript origins: `https://magnetar.codefusion.cc`
- Authorized redirect URIs: `https://magnetar.codefusion.cc/api/auth/google/callback`

The consent screen needs only the `openid`, `email` and `profile` scopes. Put the client id in
`apps/worker/wrangler.jsonc` → `vars.GOOGLE_CLIENT_ID`. It is public; no client secret is used.

## 2. D1 database

The production database `magnetar` exists and its id is in `wrangler.jsonc`. A new migration in
`apps/worker/migrations` goes out with the next deploy, which applies it before the new Worker starts. Migrations only
add: the Worker still running meanwhile must keep working on the new schema.

## 3. CodeFusion Console

The console (codefusion-cc/codefusion-console) lists Magnetar in `config/apps.json` and binds `MAGNETAR_ADMIN` to this
Worker's `ConsoleAdmin` entrypoint. Deploy this Worker first, so the console's deploy binds a service that exists.
Its Deployments page reads this repository with the console's GitHub token, which must include codefusion-cc/magnetar.

## 4. Deploy on merge

The `deploy` job in `.github/workflows/ci.yml` runs on every push to `main` after the checks and the end-to-end tests
pass. It builds the dashboard (its `version.json` names the commit), applies the D1 migrations, deploys the Worker, its
assets and the `DeviceRelay` Durable Object, and waits until the website serves the new commit. Deploys run one at a
time and are never cancelled midway; merges that land meanwhile wait, and only the newest of them deploys. The custom
domain route creates the DNS record in the `codefusion.cc` zone.

CodeFusion Console's Deployments page shows the commit the website serves, how far behind `main` it is, and the
outcome of the newest deploy (the job's GitHub deployment in the `production` environment, linked to its run).

It needs a Cloudflare API token, once. On dash.cloudflare.com, **My Profile → API Tokens → Create Token**, template
**Edit Cloudflare Workers**, then add **Account · Workers · Editor** (the template's older "Workers Scripts: Edit" alone
is refused) and **Account · D1 · Edit**. Keep the template's zone permissions (the custom domain needs nothing more) and
limit the token to your account. Store it in the `production` environment, which only `main` may deploy to:

```bash
cd /Users/xeon/Projects/mediadownloader-v2 && gh api -X PUT repos/codefusion-cc/magnetar/environments/production --input - <<<'{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' && gh api -X POST repos/codefusion-cc/magnetar/environments/production/deployment-branch-policies -f name=main -f type=branch && gh secret set CLOUDFLARE_API_TOKEN --env production --repo codefusion-cc/magnetar
```

A failed deploy leaves the website on the previous build: fix the cause and merge again, or re-run the job. In an
emergency, `npm run deploy -w @magnetar/worker` (after `npm run migrate:remote -w @magnetar/worker` when a migration
is new) deploys the checkout from this Mac with your own `wrangler login`.

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
`RELEASES_REPO` (a Worker var, `codefusion-cc/magnetar` by default). Asset names must stay
`Magnetar-<version>-<macos|windows|linux>-<arm64|x64>[.zip|.exe]`. The same list answers `/about`'s changelog and the
"your app is outdated" notice; GitHub is asked at most every ten minutes per data centre.

GitHub allows 60 anonymous API calls an hour per address, which Cloudflare's addresses share with other Workers. A
token raises that to 5,000: a fine-grained GitHub token with no permissions (public repositories only), stored once
with `npx wrangler secret put GITHUB_TOKEN` from `apps/worker`. Without it, a rate-limited lookup shows "GitHub's
limit is reached" and is asked again on the next visit.
