# Deploying mediadownloader.codefusion.cc

The Worker in `apps/worker` serves the website, sign-in, pairing and the relay. One-time setup, then `bun run deploy`.

## 1. Google OAuth client

Google Cloud Console → **APIs & Services → Credentials → Create credentials → OAuth client ID**:

- Application type: **Web application**, name `MediaDownloader`
- Authorized JavaScript origins: `https://mediadownloader.codefusion.cc`
- Authorized redirect URIs: `https://mediadownloader.codefusion.cc/api/auth/google/callback`

The consent screen needs only the `openid`, `email` and `profile` scopes. Put the client id in
`apps/worker/wrangler.jsonc` → `vars.GOOGLE_CLIENT_ID`. It is public; no client secret is used.

## 2. D1 database

```bash
cd apps/worker
bunx wrangler d1 create mediadownloader
```

Paste the printed `database_id` into both `d1_databases` entries of `wrangler.jsonc`, then apply the schema:

```bash
bun run migrate:remote
```

## 3. CodeFusion Console

In the codefusion-console repo, add the app to `config/apps.json` so its failures are accepted:

```json
{
  "id": "mediadownloader",
  "name": "MediaDownloader",
  "brand": "codefusion",
  "url": "https://mediadownloader.codefusion.cc",
  "telemetry": { "scripts": { "mediadownloader": "production" } }
}
```

Deploy the console before this Worker: the `tail_consumers` entry and the `CONSOLE_TELEMETRY` service binding need it.

## 4. Deploy

```bash
bun run --cwd apps/worker deploy
```

This builds the dashboard and deploys the Worker, its assets and the `DeviceRelay` Durable Object. The custom domain
route creates the DNS record in the `codefusion.cc` zone.

## Release signing

Once, from the repo root:

```bash
bun scripts/release-key.ts
```

Commit `apps/client/release-public-key.txt` and save the printed private key as the repository secret
`RELEASE_SIGNING_KEY`. Keep no other copy: losing it means shipping a release with a new public key, which older
installs will not auto-install (they fall back to opening the release page).
