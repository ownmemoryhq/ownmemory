# Set up your own OwnMemory server

OwnMemory runs in your own Cloudflare account and keeps your memories encrypted with a key only you hold. Pick where the memories live:

| | One-click (recommended) | Google Drive (advanced) |
| --- | --- | --- |
| Memories live in | A D1 database in your Cloudflare account | An `OwnMemory` folder in your Google Drive |
| You need | A free Cloudflare account | A free Cloudflare account, a Google account and a Google Cloud OAuth app |
| Time | About 5 minutes | About 20 minutes |
| Sign-in when connecting Claude | Your passkey (or owner code plus authenticator code), then your passphrase | Google, then your passphrase |

Either way, the server never keeps your memories, passphrase or key at rest, and nobody without your passphrase or recovery key can read the memories.

## One-click setup

### 1. Deploy

**With the button:** click **Deploy to Cloudflare** in the [README](../README.md). Sign in to Cloudflare, connect a free GitHub or GitLab account when asked, and enter an **owner code**: a code only you know, at least 12 characters, kept in your password manager. Cloudflare creates the database and deploys the server, then shows its address, for example `https://ownmemory.your-name.workers.dev`.

**From a terminal** (needs Node.js 20 or newer):

```sh
git clone https://github.com/ownmemoryhq/ownmemory.git
cd own-memory/server
npm install
npx wrangler login
npx wrangler deploy                        # creates the D1 database and KV namespace, prints your address
npx wrangler secret put OWNER_CODE         # at least 12 characters
```

If `wrangler.jsonc` already lists `"id"` values for `OAUTH_KV` or `DB`, they belong to someone else's account: delete them first.

### 2. Follow the setup page

Open your server's address. It walks you through the rest, with copy buttons:

1. **Add it to Claude:** on claude.ai, Settings → Connectors → Add custom connector, with your address plus `/mcp`. Add it on the web first; it then appears in the Claude phone apps.
2. **Connect:** enter your owner code, then protect the server with a **passkey** (Face ID, a fingerprint, Windows Hello or your phone) or an **authenticator app**. Then choose a passphrase (at least 10 characters) and save the recovery key it shows you. It's shown once.

   From then on the owner code alone no longer signs in, so nobody can sit and guess it: you sign in with your passkey, or with the owner code plus the 6-digit code from your authenticator app. Add more passkeys (one per device, or one in your password manager) on the memories page.
3. **Tell Claude to use it (required):** paste the text from the setup page into **Instructions for Claude** in Claude's settings. Without it, Claude ignores the connector.
4. **Bring over what Claude already knows:** in a new chat, say "Save everything you remember about me to OwnMemory."

Then continue with [Working alongside Claude's memory](#working-alongside-claudes-memory).

## Google Drive setup (advanced)

You need Node.js 20 or newer and a Google account.

### 1. Install and deploy once

```sh
git clone https://github.com/ownmemoryhq/ownmemory.git
cd own-memory/server
npm install
```

In `server/wrangler.jsonc`, change `"STORAGE": "d1"` to `"STORAGE": "drive"`, and delete any `"id"` values that came with the repo. Then:

```sh
npx wrangler login
npx wrangler deploy
```

Note the address it prints. Until step 3 the server refuses everyone, so it's safe to leave it running.

### 2. Create a Google OAuth client

In the [Google Cloud console](https://console.cloud.google.com/):

1. **Create a project**, for example "OwnMemory".
2. **Enable the Google Drive API**: APIs & Services → Library → Google Drive API → Enable.
3. **Configure sign-in**: Google Auth Platform → Get started.
   - App name: OwnMemory. Support email: yours.
   - Audience: **External**.
   - Contact email: yours. Accept the policy and create.
4. **Branding**: application home page `https://<your address>`, privacy policy `https://<your address>/privacy`, and your domain under authorized domains if you use one. Google requires the privacy policy before publishing.
5. **Data access** → Add or remove scopes → add `openid`, `.../auth/userinfo.email` and `.../auth/drive.file` → Update → Save.
6. **Audience** → **Publish app** → Confirm.
   Leave it in "Testing" and Google expires your Drive access every 7 days. Publishing needs no review because `drive.file` is a non-sensitive scope, and `ALLOWED_EMAILS` still keeps everyone else out. Google may show an "unverified app" notice: choose Advanced → Go to OwnMemory.
7. **Clients** → Create client:
   - Application type: **Web application**
   - Authorized redirect URIs: `https://<your address>/callback`
   - Create, then copy the **Client ID** and **Client secret**.

### 3. Give the server its secrets

```sh
npx wrangler secret put ALLOWED_EMAILS
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

For `ALLOWED_EMAILS`, enter your Google address (several are comma-separated). Only those accounts can connect; everyone else is refused right after Google sign-in.

### 4. Follow the setup page

Open your server's address and follow the same four steps as the one-click setup. When connecting, you sign in with Google instead of entering an owner code. **Tick the Google Drive checkbox** on Google's screen; if you miss it, OwnMemory asks once more.

## Working alongside Claude's memory

Claude has a built-in memory (Settings → Capabilities → Memory). OwnMemory works with it in one of three modes, and every new connection starts in **ramp-up**:

| Mode | Claude's memory | What OwnMemory does |
| --- | --- | --- |
| Ramp-up (first 14 days) | On | Saves a copy of every new fact; Claude's memory handles recall. Claude mentions progress once a day |
| OwnMemory only | Off | Your only memory: Claude loads and searches it |
| Keep both | On | Saves a copy of every new fact, with no reminders |

After 14 days (and at least 20 memories), Claude asks whether you'd like to turn off its built-in memory. Answer "turned it off", "not yet" (asks again in 7 days) or "keep both" (no more reminders). Change your mind any time by telling Claude, for example "I've turned off Claude's memory" or "restart the OwnMemory ramp-up".

Then try it: tell Claude something about yourself, start a new chat, and ask what it remembers.

## Everyday controls

| To… | Do this |
| --- | --- |
| Never save a category | `npx wrangler secret put BLOCKED_CATEGORIES` and enter e.g. `health,finance` |
| Pause all saving | `npx wrangler secret put WRITES_PAUSED` and enter `true` (enter `false` to resume) |
| Never send memory text to Workers AI | `npx wrangler secret put SEMANTIC_SEARCH` and enter `off`; search then uses keywords only |
| Make Claude forget something | Ask Claude to delete it. Deleted memories are kept 30 days in D1, or in the Drive trash |
| See, search, fix or add memories | Open `/memories` on your server. Sign in with your passkey or codes (Drive setup: with Google), then enter your passphrase. Memories are decrypted and re-encrypted in your browser; the session ends after an hour, and the page locks after 15 idle minutes |
| Read or export everything | On `/memories`, click **Download all**: a zip of Markdown files, decrypted in your browser |
| See or disconnect connected apps | The **Connected apps** card on `/memories` lists each app connected to your server (Claude on the web, Claude Code…). **Disconnect** ends it within about a minute; the app has to sign in again. Apps otherwise stay connected until you remove OwnMemory in them |
| Add or remove a passkey or authenticator app | One-click setup: the **Sign-in methods** card at the bottom of `/memories`. The server always keeps at least one |
| Change your passphrase | Disconnect and reconnect the connector, choose "Forgot your passphrase? Use your recovery key", and set a new one |
| Cut off access | Disconnect the connector in Claude (deletes the server's only copy of your key). Drive setup: also remove OwnMemory at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) |

Categories: `profile`, `preference`, `work`, `project`, `relationship`, `health`, `finance`, `other`. The server also refuses anything that looks like a password, API key or card number.

**If your server is gone.** Your memories don't depend on it. With the Drive setup, download the OwnMemory folder from Google Drive and open [ownmemory.app/decrypt](https://ownmemory.app/decrypt): it decrypts the zip in your browser with your passphrase or recovery key, and the page can't send anything over the network. From the terminal, `npm run decrypt -- ~/Downloads/OwnMemory --out ~/my-memories` in `server/` does the same. With the one-click setup the files live in the server's own D1 database, so keep a backup with **Download all** on the memories page now and then.

## Optional: your own domain

A domain isn't needed: the `workers.dev` address works in Claude.

1. Add your domain to Cloudflare, then deploy with `npx wrangler deploy --domain mcp.example.com` (pass the flag on every deploy, or the domain may be dropped).
2. `npx wrangler secret put PUBLIC_URL` and enter `https://mcp.example.com`.
3. Drive setup: add `https://mcp.example.com/callback` to the Google client's redirect URIs.
4. In Claude, remove the connector and add it again with `https://mcp.example.com/mcp`. Unlock with your existing passphrase: your memories stay as they are.

## Local development

```sh
cp .dev.vars.example .dev.vars   # set OWNER_CODE (one-click) or the Google lines (Drive)
npm run dev                      # http://localhost:8788, with a local D1 database
npm test                         # key handling, format, search, duplicates and ramp-up tests
npm run eval                     # recall evaluation with real Workers AI embeddings
npm run typecheck
```

## Troubleshooting

- **"That owner code is not correct"** or **"Too many wrong codes"**: after 10 wrong owner or authenticator codes in an hour, the server waits an hour.
- **Lost your passkeys or authenticator app** (one-click): change the owner code, with `npx wrangler secret put OWNER_CODE` or in the Cloudflare dashboard (your Worker → Settings → Variables and Secrets). That resets the sign-in methods and ends every connected app and open memories-page session, so a lost device loses access too; connect again with the new owner code and set up a new passkey. Your memories and passphrase stay as they are. With the Drive setup, disconnect the lost device's apps on the memories page instead.
- **Passkey doesn't work after moving to your own domain** (one-click): passkeys belong to one web address. Sign in with your authenticator app if you set one up, or reset sign-in by changing the owner code, then add a passkey on the new address.
- **"This account can't use this server"** (Drive): the Google account isn't in `ALLOWED_EMAILS`. Run `npx wrangler secret put ALLOWED_EMAILS` with the right address, then connect again.
- **"Google didn't grant offline access"** (Drive): remove OwnMemory at myaccount.google.com/permissions, then connect again.
- **Reconnect needed after a week** (Drive): the Google app is still in Testing. Publish it and reconnect.
- **redirect_uri_mismatch** (Drive): the redirect URI in the Google client must match your address plus `/callback` exactly.
- **Claude doesn't save or load memories**: check the Instructions for Claude text is in place, and start a new chat.
- **Logs**: `npx wrangler tail` shows requests and errors. The server never logs memory contents.
