# Who can read your memories

OwnMemory stores your memories encrypted, under a key that only your passphrase (or your recovery key) can unlock. This page goes through everyone who could get at them, what they can see, and what keeps them out. For how the encryption works, see [How your memories stay yours](../README.md#how-your-memories-stay-yours).

## The short version

| Who | Can they read your memories? |
| --- | --- |
| You | Yes, with your passphrase or recovery key |
| Claude, and any other app you connect | Yes: that's the point. Each connection can read and change memories until you disconnect it |
| Your OwnMemory server | Only while it handles a request from a connected app; it never stores them unencrypted |
| Cloudflare | Stores only encrypted files. It runs your server, so you trust it not to inspect the server while it runs |
| Google (Drive storage) | No: it stores only encrypted files |
| Us, the people who write OwnMemory | No. We have no access to your server and it never contacts us. Updates you install are code that runs on your server, so they're the one way in |
| Someone who knows your owner code (one-click servers) | No: after your first sign-in they also need your passkey or authenticator app, and then your passphrase |
| Someone who gets your Cloudflare or GitHub account | Not the memories already stored, but they could change your server's code and capture the key the next time you connect. Protect both accounts with two-factor sign-in |
| Someone with a device where Claude is connected | Yes, through Claude, until you disconnect that device |
| Someone with a downloaded copy | Yes: **Download all** gives you plain Markdown files |

## In more detail

### You

Your passphrase unlocks the memory key in your browser and is never sent anywhere. The recovery key you saved at setup does the same if you forget the passphrase. If you lose both, nobody can read your memories, including you and us.

### Claude and other connected apps

When you connect an app, your browser unlocks the memory key and hands it to your server, which keeps it inside that app's connection, encrypted with the app's access token. The app can then save, search, change and delete memories. Everything Claude reads from OwnMemory, or that you say in a chat, also goes to Anthropic, as with any chat.

To end a connection, open your server's `/memories` page and choose **Disconnect** under Connected apps; its copy of the key is deleted with it. A connection also ends by itself after 90 days without use.

### Your OwnMemory server

The server is a Cloudflare Worker in your own Cloudflare account. While it handles a request, it has the unlocked key and sees the memory it's saving or searching. It never writes a memory or the key to storage unencrypted, and its logs record requests, never memory text.

What it stores, all in your own accounts:

| What | Where | Readable without your passphrase? |
| --- | --- | --- |
| Memories and the search index | D1 database, or the OwnMemory folder in your Google Drive | No: encrypted |
| The locked memory key (`keyinfo.json`) | Same place | No: needs your passphrase or recovery key |
| Each connection's copy of the key | Cloudflare KV | No: encrypted with that app's access token |
| Sign-in methods (passkeys, authenticator app) | D1 database | Not memories: these only control who can sign in |

### Cloudflare

Cloudflare stores your encrypted files and runs your server. Like any cloud provider, it could in principle inspect the server while it runs; running it in your own account means nobody else's code or staff are in between.

Search by meaning sends memory text to Cloudflare Workers AI, also in your own account, to compute a search index (which is then stored encrypted). To keep memory text away from it, set the `SEMANTIC_SEARCH` secret to `off`; search then uses keywords only.

### Google (Drive storage only)

If you chose Google Drive storage, Google stores the encrypted files. OwnMemory asks only for access to the files it creates, not your whole Drive.

### Us

We don't run your server and can't reach it. It has no telemetry and never contacts us; we only see download counts on GitHub.

To tell you when a new version is out, your server asks GitHub's public API for the latest OwnMemory release, at most twice a day. That request carries nothing about you or your memories, and it goes to GitHub, not to us. To stop it, set the `UPDATE_CHECK` secret to `off`.

Updates are the exception: an update is new code that runs on your server and sees the key like the current code does. Your server updates only when you run the **Update OwnMemory** workflow (or if you turned on its weekly schedule). Every release is public on GitHub, so you, or anyone, can read what changed before installing it.

### Someone trying to sign in to your server

Anyone can open your server's address, so it guards the way in. With Google Drive storage, signing in takes a Google account on the server's `ALLOWED_EMAILS` list. On a one-click server:

- **Before your first sign-in**, the owner code alone signs in. Choose a random code of 12 or more characters, and sign in soon after deploying: your first sign-in sets up a passkey or an authenticator app.
- **After that**, signing in takes a passkey, or the owner code plus a 6-digit code from your authenticator app.
- Only 10 wrong codes per hour are allowed from each network address.
- Even then, your memories stay locked until your passphrase unlocks them, in the browser.

Lost every passkey and your authenticator? Change the `OWNER_CODE` secret in the Cloudflare dashboard. That resets the sign-in methods and ends every connection, and your passphrase still unlocks the memories.

### Your Cloudflare and GitHub accounts

Whoever controls your Cloudflare account, or can change the code in your GitHub copy (Cloudflare redeploys it automatically), controls what your server runs. They can't decrypt the memories already stored, but they could change the code to capture the key the next time you connect. Turn on two-factor sign-in for both accounts, and don't give others access to them.

### Your devices

A device where Claude is connected can use your memories through Claude, without the passphrase. If you lose a device, disconnect it on the `/memories` page.

A file from **Download all** is not encrypted: it's your memories as plain Markdown. Keep it like any private document, or delete it when you're done.

## Not yet done

OwnMemory hasn't had an independent security audit yet. If you find a problem, please report it privately: see [SECURITY.md](../SECURITY.md).
