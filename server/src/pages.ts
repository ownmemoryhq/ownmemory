import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

export const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const MARK = `<svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="43" fill="none" stroke="currentColor" stroke-width="16"/><circle cx="69" cy="51" r="12" fill="var(--accent)"/></svg>`;

const SECURITY_HEADERS = {
	"Content-Type": "text/html; charset=utf-8",
	// No inline script: every script is a file served from this origin (public/).
	"Content-Security-Policy":
		"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "no-referrer",
	"Cache-Control": "no-store",
};

function layout(title: string, body: string, scripts = "", wide = false) {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · OwnMemory</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<main${wide ? ' class="wide"' : ""}>
<div class="brand">${MARK}<span><b>Own</b>Memory</span></div>
${body}
</main>
${scripts}
</body>
</html>`;
}

/** Builds an HTML response, keeping any headers a helper already set (cookies, CSP). */
export function htmlResponse(html: string, headers?: Headers, status = 200) {
	const out = new Headers(headers);
	for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
		if (k === "Content-Security-Policy" && out.has(k)) out.append(k, v);
		else out.set(k, v);
	}
	return new Response(html, { status, headers: out });
}

/** The text the owner pastes into "Instructions for Claude"; Claude ignores the connector without it. */
export const CLAUDE_INSTRUCTIONS =
	"I use the OwnMemory connector as my long-term memory. At the start of every conversation, before replying, call OwnMemory's load_core_memories and follow what it says. Whenever you learn something durable about me (who I am, my preferences, decisions, projects, people in my life), save it with OwnMemory's save_memory. Every time you update your built-in memory, also save the same fact to OwnMemory in the same reply. Search OwnMemory before answering anything that depends on my history or preferences.";

/** The setup wizard: everything the owner does after deploying, in order. */
export function homePage(origin: string, d1: boolean, ownerCodeOk = true) {
	const url = `${origin}/mcp`;
	// The deploy form accepts any owner code; the server needs 12 characters or more.
	const fixOwnerCode =
		d1 && !ownerCodeOk
			? `<div class="warning" role="alert">
<h2>Fix your owner code first</h2>
<p>This server's owner code is missing or shorter than 12 characters, so nobody can connect. In the Cloudflare dashboard, open <strong>Build</strong> → <strong>Compute</strong> → <strong>Workers &amp; Pages</strong> → this Worker → <strong>Settings</strong> → <strong>Variables and Secrets</strong>, edit <strong>OWNER_CODE</strong>, and enter a random code of at least 12 characters from your password manager, one you use nowhere else. It takes effect within a minute; then reload this page.</p>
</div>`
			: "";
	const where = d1 ? "in this server's own database, in your Cloudflare account" : "in your Google Drive";
	return layout(
		"Set up",
		`${fixOwnerCode}<div class="card">
<h1>Your OwnMemory server is running</h1>
<p>It keeps what Claude learns about you ${where}, encrypted with a key only you hold. Four steps to start:</p>
</div>

<section class="card step">
<h2>1. Add it to Claude</h2>
<p>On claude.ai, open Settings → Connectors → <strong>Add custom connector</strong>, name it OwnMemory, and paste this URL:</p>
<div class="code" id="connector-url">${escape(url)}</div>
<p><button type="button" class="secondary" data-copy="connector-url">Copy URL</button></p>
<p class="note">Add it on the web first; it then appears in the Claude phone apps too.</p>
</section>

<section class="card step">
<h2>2. Connect and choose your passphrase</h2>
<p>Click <strong>Connect</strong> in Claude.${d1 ? " Enter the owner code you chose when you deployed this server, then add a passkey (or an authenticator app): from then on you sign in with that, not the owner code alone." : " Sign in with Google and allow access to Google Drive files."} Then choose a passphrase and save the recovery key it shows you, for example in your password manager.</p>
<p class="note">Your passphrase never leaves your browser. Without it or the recovery key, nobody can read your memories, including whoever runs this server.</p>
</section>

<section class="card step">
<h2>3. Tell Claude to use it</h2>
<p>This step is required. In Claude, open Settings and paste this into <strong>Instructions for Claude</strong>:</p>
<div class="code prose" id="instructions">${escape(CLAUDE_INSTRUCTIONS)}</div>
<p><button type="button" class="secondary" data-copy="instructions">Copy instructions</button></p>
<p>Then let Claude save without asking each time: in Settings → <strong>Connectors</strong>, open OwnMemory and set its tool permissions to <strong>Always allow</strong>. You can leave <strong>Delete a memory</strong> on approval, if you like to confirm deletions.</p>
</section>

<section class="card step">
<h2>4. Bring over what Claude already knows</h2>
<p>In a new chat, say: <strong>"Save everything you remember about me to OwnMemory."</strong></p>
<p>For two weeks OwnMemory runs alongside Claude's built-in memory. Then Claude asks whether to switch it off, keep both, or wait.</p>
</section>

<p class="note"><a href="/memories">See, edit or download my memories</a> · <a href="/privacy">Privacy policy</a></p>`,
		`<script type="module" src="/home.js"></script>`,
	);
}

export function privacyPage(origin: string, d1: boolean) {
	const accesses = d1
		? "<p>Nothing outside this server. Memories are stored in this server's own D1 database, in the owner's Cloudflare account. Signing in requires the owner's passkey, or the owner code plus a code from their authenticator app; the passkeys' public keys and the authenticator secret are stored in the same database.</p>"
		: "<p>With your permission it uses your Google account's email address, to check you are allowed to connect, and the Google Drive <strong>drive.file</strong> scope, which covers only the files this server creates in an <strong>OwnMemory</strong> folder. It cannot see any other file in your Drive.</p>";
	const sharing = d1
		? "<p>Memories are used only to save and retrieve them for Claude. They are not sold, shared, used for advertising or used to train AI models.</p>"
		: '<p>Data from Google APIs is used only to save and retrieve your memories. It is not sold, shared, used for advertising or used to train AI models. OwnMemory\'s use of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>';
	const deleting = d1
		? '<p>Download your memories from the <a href="/memories">memories page</a> first if you want a copy, then delete this Worker and its D1 database in your Cloudflare account. Disconnecting the connector in Claude revokes access.</p>'
		: '<p>Delete the OwnMemory folder in your Drive to delete every memory. Disconnect the connector in Claude, or remove OwnMemory at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>, to revoke access.</p>';
	return layout(
		"Privacy policy",
		`<div class="card">
<h1>Privacy policy</h1>
<p>This OwnMemory server at <strong>${escape(origin)}</strong> is run by its owner for their own use. It lets Claude save and recall the owner's memories.</p>
<h2>What it accesses</h2>
${accesses}
<h2>How your data is stored</h2>
<p>Every memory is encrypted with a key only you hold before it is stored. The key is unlocked by a passphrase that never leaves your browser. The server keeps no memory content, no passphrase and no key at rest; it uses them only while handling a request from Claude, and does not log them.</p>
<p>For search by meaning, memory text and search queries are sent to Cloudflare Workers AI in the owner's own Cloudflare account to compute search vectors, which are then stored encrypted like the memories. The owner can switch this off.</p>
<h2>Sharing</h2>
${sharing}
<h2>Deleting your data</h2>
${deleting}
<p>Step by step, including handing your memories back to Claude: <a href="https://github.com/ownmemoryhq/ownmemory/blob/main/docs/setup.md#stop-using-ownmemory">Stop using OwnMemory</a>.</p>
<h2>Contact</h2>
<p>${d1 ? "Contact the owner of this server." : "Use the support email shown on Google's sign-in screen for this app."}</p>
</div>`,
	);
}

/** The memories page: browse, search, edit, add and delete, decrypted in the browser. */
export function memoriesPage(d1: boolean) {
	const data = JSON.stringify({ d1 }).replace(/</g, "\\u003c");
	return layout(
		"My memories",
		`<div class="card" id="intro">
<h1>My memories</h1>
<p>See, search and fix what your AI assistants have saved about you. Memories are decrypted and encrypted on this page: your passphrase and your memories never leave your device.</p>
</div>

<section class="card" id="signin-panel" data-panel hidden>
<h2>Sign in</h2>
<p>Sign in with the Google account this server stores your memories for.</p>
<div class="actions"><a class="button" href="/memories/google">Sign in with Google</a></div>
</section>

<section class="card" id="gate-panel" data-panel hidden></section>

<div id="account" data-panel hidden>
<div class="account-bar">
<p class="note" id="account-status">Signed in</p>
<button type="button" class="secondary" id="lock">Sign out</button>
</div>

<details class="section" id="connections">
<summary><span class="section-title">Connected apps</span><span class="count" id="connections-count"></span></summary>
<p class="note">Apps that can read and save your memories, such as Claude. They stay connected until you disconnect them here or remove OwnMemory in the app. Disconnect any you don't recognize, or that ran on a device you lost.</p>
<ul class="methods" id="connections-list"></ul>
<p class="error" id="connections-error" role="alert"></p>
</details>
${
	d1
		? `
<details class="section" id="security-section">
<summary><span class="section-title">Sign-in methods</span><span class="count" id="security-count"></span></summary>
<div id="security" data-bare="true"></div>
</details>`
		: ""
}

<details class="section" id="memories-section" open>
<summary><span class="section-title">Memories</span><span class="count" id="memories-count"></span></summary>

<div id="unlock-panel" data-view hidden>
<p>Enter your passphrase to see them. It's checked on this page and never sent anywhere.</p>
<form id="unlock-form" novalidate>
<label for="memories-pass">Passphrase</label>
<input id="memories-pass" name="passphrase" type="password" autocomplete="current-password" required>
<p class="error" role="alert"></p>
<div class="actions"><button type="submit">Unlock</button></div>
</form>
</div>

<div id="no-key" data-view hidden>
<p>None yet. Connect Claude to this server first: that's where you choose your passphrase. Your memories will then show here.</p>
</div>

<div id="library" data-view hidden>
<div class="toolbar">
<label class="sr-only" for="search">Search memories</label>
<input id="search" type="search" placeholder="Search memories" autocomplete="off">
<label class="sr-only" for="filter">Category</label>
<select id="filter"><option value="">All categories</option></select>
</div>
<div class="toolbar">
<p class="note" id="status" role="status"></p>
<button type="button" id="add">Add a memory</button>
<button type="button" class="secondary" id="download">Download all</button>
</div>
<div class="warning" id="download-warning" role="alertdialog" aria-labelledby="download-warning-title" hidden>
<h3 id="download-warning-title">Your download won't be encrypted</h3>
<p>Anyone who opens these files can read your memories. Keep them somewhere private, don't email or share them, and delete them when you're done.</p>
<div class="actions"><button type="button" id="download-confirm">Download</button><button type="button" class="secondary" id="download-cancel">Cancel</button></div>
</div>
<p class="error" id="library-error" role="alert"></p>
<div id="new-memory"></div>
<ul class="memories" id="list"></ul>
</div>
</details>
</div>

<p class="note"><a href="/">Back to setup</a> · Lost access to this server? <a href="https://ownmemory.app/decrypt">Decrypt a downloaded copy</a></p>
<script type="application/json" id="om-data">${data}</script>`,
		`<script type="module" src="/memories.js"></script>`,
		true,
	);
}

export function consentPage(details: ConsentDescription, handle: string, d1: boolean) {
	const name = escape(details.clientName);
	const origin = details.clientDomain
		? `Published by <strong>${escape(details.clientDomain)}</strong>.`
		: "This app registered itself, so its name is not verified.";
	return layout(
		`Connect ${details.clientName}`,
		`<div class="card">
<h1>Allow ${name} to use your memory?</h1>
<p>${origin} Access goes to <strong>${escape(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>" : ""}
${
	d1
		? `<p>Next you'll sign in to this server and unlock your memory with your passphrase. ${name} will be able to save, search and delete your memories.</p>`
		: `<p>Next you'll sign in with Google. <strong>Allow access to Google Drive files</strong> when Google asks: OwnMemory can only see the files it creates. Then you'll unlock your memory with your passphrase. ${name} will be able to save, search and delete memories in the OwnMemory folder of your Drive.</p>`
}
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escape(handle)}">
<div class="actions">
<button type="submit" name="decision" value="approve">${d1 ? "Continue" : "Continue with Google"}</button>
<button type="submit" name="decision" value="deny" class="secondary">Cancel</button>
</div>
</form>
</div>`,
	);
}

export interface UnlockPageOptions {
	/** gate: a one-click server's sign-in step (passkey or codes) comes first. */
	mode: "gate" | "create" | "unlock";
	email: string;
	handle: string;
	keyinfo: unknown;
}

export function unlockPage({ mode, email, handle, keyinfo }: UnlockPageOptions) {
	// Data for /unlock.js. JSON inside a non-executable script tag; "<" is escaped so the
	// content can never close the tag.
	const data = JSON.stringify({ mode, keyinfo: keyinfo ?? null }).replace(/</g, "\\u003c");
	return layout(
		mode === "gate" ? "Sign in" : mode === "create" ? "Create your memory key" : "Unlock your memory",
		`${email ? `<p class="note">Signed in as <strong>${escape(email)}</strong></p>` : ""}

<section class="card" id="gate-panel" data-panel hidden></section>

<section class="card" id="create-panel" data-panel hidden>
<h1>Create your memory key</h1>
<p>Your memories are encrypted with a key that only this passphrase can unlock. It never leaves this page: not even the server sees it.</p>
<form id="create-form" novalidate>
<label for="create-pass">Passphrase</label>
<input id="create-pass" name="passphrase" type="password" autocomplete="new-password" minlength="10" required>
<label for="create-confirm">Type it again</label>
<input id="create-confirm" name="confirm" type="password" autocomplete="new-password" required>
<p class="error" role="alert"></p>
<div class="actions"><button type="submit">Create key</button></div>
</form>
</section>

<section class="card" id="recovery-panel" data-panel hidden>
<h1>Save your recovery key</h1>
<p>If you forget your passphrase, this is the only way back into your memories. Nobody else can recover them, including the server's owner.</p>
<div class="code" id="recovery-code"></div>
<p><button type="button" class="secondary" id="copy-recovery">Copy</button> <button type="button" class="secondary" id="download-recovery">Download</button></p>
<p class="note">Keep it in your password manager, or print the downloaded file and delete it from your computer. It's shown only once.</p>
<form id="recovery-form">
<label class="check"><input type="checkbox" id="recovery-saved"> I saved my recovery key somewhere safe</label>
<div class="actions"><button type="submit" id="recovery-continue" disabled>Continue</button></div>
</form>
</section>

<section class="card" id="unlock-panel" data-panel hidden>
<h1>Unlock your memory</h1>
<p>Enter your OwnMemory passphrase. It's checked on this page and never sent anywhere.</p>
<form id="unlock-form" novalidate>
<label for="unlock-pass">Passphrase</label>
<input id="unlock-pass" name="passphrase" type="password" autocomplete="current-password" required>
<p class="error" role="alert"></p>
<div class="actions"><button type="submit">Unlock</button></div>
</form>
<p><button type="button" class="link" id="show-recover">Forgot your passphrase? Use your recovery key</button></p>
</section>

<section class="card" id="recover-panel" data-panel hidden>
<h1>Use your recovery key</h1>
<p>Enter the recovery key you saved, then choose a new passphrase. Your memories stay as they are.</p>
<form id="recover-form" novalidate>
<label for="recover-code">Recovery key</label>
<input id="recover-code" name="recovery" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" required>
<label for="recover-pass">New passphrase</label>
<input id="recover-pass" name="passphrase" type="password" autocomplete="new-password" required>
<label for="recover-confirm">Type it again</label>
<input id="recover-confirm" name="confirm" type="password" autocomplete="new-password" required>
<p class="error" role="alert"></p>
<div class="actions"><button type="submit">Set new passphrase</button></div>
</form>
<p><button type="button" class="link" id="show-unlock">Back to passphrase</button></p>
</section>

<form id="finish-form" method="post" action="/unlock" hidden>
<input type="hidden" name="handle" value="${escape(handle)}">
<input type="hidden" name="mode">
<input type="hidden" name="memoryKey">
<input type="hidden" name="keyinfo">
</form>
<script type="application/json" id="om-data">${data}</script>`,
		`<script type="module" src="/unlock.js"></script>`,
	);
}

export function errorPage(title: string, message: string) {
	return layout(title, `<div class="card"><h1>${escape(title)}</h1><p>${escape(message)}</p></div>`);
}
