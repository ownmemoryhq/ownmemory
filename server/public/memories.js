// The memories page. Decrypts, edits and re-encrypts memories here in the browser; the
// server only ever receives ciphertext. The unlocked key lives in this page's memory and is
// dropped on Sign out, after 15 idle minutes, or when the page closes.
//
// Once signed in (passkey or codes, or Google), the account sections show at once: Sign out,
// Connected apps and Sign-in methods need no passphrase. The memories need the passphrase.
import { decryptMemory, encryptMemory, importMemoryKey, unlockWithPassphrase } from "/keys.js";
import { CATEGORIES, HISTORY_LIMIT, fromMarkdown, looksLikeSecret, toMarkdown } from "/memory-file.js";
import { SignInNeeded, manage, signIn } from "/gate.js";
import { download, memoryFileName, zip } from "/zip.js";

const { d1 } = JSON.parse(document.getElementById("om-data").textContent);
const $ = (id) => document.getElementById(id);
const IDLE_LOCK = 15 * 60_000;
const MAX_CONTENT = 2000;
const MAX_TITLE = 120;

let key = null;
let keyinfo = null;
let files = null; // ciphertext from the server, until unlocked
let memories = []; // { id, modified, ...fields }
let unreadable = 0;
let idleTimer = 0;

function focusIn(node) {
	[...node.querySelectorAll("input")].find((input) => !input.closest("[hidden]"))?.focus();
}

/** The page's main state: Google sign-in, the passkey or codes step, or signed in. */
function show(id) {
	for (const panel of document.querySelectorAll("[data-panel]")) panel.hidden = panel.id !== id;
	focusIn($(id));
}

/** Inside the Memories section: passphrase, none yet, or the list. */
function showView(id) {
	for (const view of document.querySelectorAll("[data-view]")) view.hidden = view.id !== id;
	focusIn($(id));
}

const count = (id, text) => {
	if ($(id)) $(id).textContent = text;
};

function el(tag, props = {}, ...children) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === "class") node.className = v;
		else if (k in node) node[k] = v;
		else node.setAttribute(k, v);
	}
	for (const child of children) if (child != null) node.append(child);
	return node;
}

const day = (iso) => (iso || "").slice(0, 10);
/** Date and time in the viewer's own time zone and language, e.g. "Oct 15, 2026, 3:42 PM". */
const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function defaultTitle(content) {
	const first = content.trim().split(/\n/)[0];
	return first.length > 80 ? `${first.slice(0, 77)}…` : first;
}

/** Whether the title says more than the first words of the content (as Claude sees it). */
const titled = (m) => m.title && !m.content.startsWith(m.title.replace(/…$/, ""));

async function api(method, path, body) {
	const response = await fetch(path, {
		method,
		headers: body === undefined ? {} : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const result = await response.json().catch(() => ({}));
	if (response.status === 401 && result.signIn) throw new SignInNeeded(result.error);
	if (!response.ok) throw Object.assign(new Error(result.error || "Something went wrong. Try again."), { noKey: !!result.noKey });
	return result;
}

/** Signed in: show the account sections, which need no passphrase. */
function enterAccount(email) {
	show("account");
	$("account-status").textContent = email ? `Signed in as ${email}` : "Signed in";
	showConnections();
	if (d1) manage($("security"), needSignIn, (n) => count("security-count", String(n)));
	showUpdate();
}

/** "A new version is available", when the server knows of a newer release. */
async function showUpdate() {
	const notice = $("update-notice");
	try {
		const { update, guide } = await api("GET", "/memories/update");
		if (!update) return;
		const link = (href, text) => Object.assign(document.createElement("a"), { href, textContent: text, target: "_blank", rel: "noopener" });
		notice.replaceChildren(
			`OwnMemory ${update.latest} is available; this server runs ${update.current}. `,
			link(update.url, "What's new"),
			" · ",
			link(guide, "How to update"),
		);
		notice.hidden = false;
	} catch {
		// No notice: the check is best-effort.
	}
}

/** Signed in, but there's no memory key yet. */
function showNoKey() {
	enterAccount();
	showView("no-key");
	count("memories-count", "none yet");
}

// ---- Connected apps ------------------------------------------------------------------------

async function showConnections() {
	const list = $("connections-list");
	const error = $("connections-error");
	error.textContent = "";
	try {
		const { connections } = await api("GET", "/memories/connections");
		list.replaceChildren(
			...connections.map((item) => {
				const disconnect = el("button", { type: "button", class: "link" }, "Disconnect");
				disconnect.addEventListener("click", async () => {
					const again = d1 ? "your passkey and passphrase" : "Google and your passphrase";
					if (!confirm(`Disconnect ${item.app} (connected ${when(item.connected)})? It will need to sign in again with ${again}.`)) return;
					try {
						await api("DELETE", `/memories/connections/${encodeURIComponent(item.id)}`, {});
						showConnections();
					} catch (e) {
						if (e instanceof SignInNeeded) return needSignIn();
						error.textContent = e.message;
					}
				});
				return el("li", {}, el("span", {}, el("strong", {}, item.app), el("br"), el("span", { class: "note" }, `Connected ${when(item.connected)}`)), disconnect);
			}),
		);
		if (!connections.length) list.replaceChildren(el("li", {}, el("span", { class: "note" }, "No apps are connected.")));
		count("connections-count", String(connections.length));
	} catch (e) {
		if (e instanceof SignInNeeded) return needSignIn();
		error.textContent = e.message;
	}
}

// ---- Opening: sign in (passkey or codes, or Google), then the passphrase -----------------

async function loadFiles() {
	const result = await api("GET", "/memories/files");
	keyinfo = result.keyinfo;
	files = result.files;
	enterAccount(result.email);
	showView("unlock-panel");
	count("memories-count", "locked");
}

async function start() {
	try {
		await loadFiles();
	} catch (error) {
		if (error instanceof SignInNeeded) return needSignIn();
		if (error.noKey) return showNoKey();
		$("intro").append(el("p", { class: "error" }, error.message));
	}
}

async function needSignIn() {
	lock(false);
	files = null;
	if (!d1) return show("signin-panel");
	show("gate-panel");
	try {
		await signIn($("gate-panel"), "/memories/gate");
		await loadFiles();
	} catch (error) {
		if (error.noKey) return showNoKey();
		$("gate-panel").replaceChildren(el("p", { class: "error" }, error.message || String(error)));
	}
}

$("unlock-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	const form = event.currentTarget;
	const button = form.querySelector("button[type=submit]");
	const error = form.querySelector(".error");
	error.textContent = "";
	button.disabled = true;
	button.textContent = "Unlocking…";
	try {
		key = await importMemoryKey(await unlockWithPassphrase(keyinfo, form.elements.passphrase.value));
		form.elements.passphrase.value = "";
		await decryptAll();
		showView("library");
		render();
		touch();
	} catch (e) {
		if (e instanceof SignInNeeded) needSignIn();
		else error.textContent = e.message || String(e);
	} finally {
		button.disabled = false;
		button.textContent = "Unlock";
	}
});

async function decryptAll() {
	memories = [];
	unreadable = 0;
	for (const file of files) {
		try {
			memories.push({ ...fromMarkdown(file.id, await decryptMemory(key, file.body)), modified: file.modified });
		} catch {
			unreadable++;
		}
	}
	files = []; // the ciphertext is no longer needed; a reload fetches fresh copies
}

function lock(signOut = true) {
	key = null;
	memories = [];
	$("list").replaceChildren();
	$("new-memory").replaceChildren();
	$("security")?.replaceChildren();
	$("download-warning").hidden = true;
	$("update-notice").hidden = true;
	$("connections-list").replaceChildren();
	for (const id of ["connections-count", "security-count", "memories-count"]) count(id, "");
	for (const id of ["connections", "security-section"]) if ($(id)) $(id).open = false;
	clearTimeout(idleTimer);
	if (signOut) {
		api("POST", "/memories/signout", {}).catch(() => {});
		files = null;
		needSignIn();
	}
}

$("lock").addEventListener("click", () => lock());

// Every memory as it is now, including edits made on this page, as a zip of Markdown files.
// The zip is plain text, so the page says so before saving it.
$("download").addEventListener("click", () => {
	$("download-warning").hidden = false;
	$("download-confirm").focus();
});
$("download-cancel").addEventListener("click", () => {
	$("download-warning").hidden = true;
	$("download").focus();
});
$("download-confirm").addEventListener("click", () => {
	$("download-warning").hidden = true;
	const enc = new TextEncoder();
	download(zip(memories.map((m) => ({ name: memoryFileName(m.title, m.id), data: enc.encode(toMarkdown(m)) }))));
});

function touch() {
	clearTimeout(idleTimer);
	if (key) idleTimer = setTimeout(() => lock(), IDLE_LOCK);
}
for (const type of ["keydown", "pointerdown"]) document.addEventListener(type, touch, { passive: true });

// ---- The list ------------------------------------------------------------------------------

for (const c of CATEGORIES) $("filter").append(el("option", { value: c }, c));
$("search").addEventListener("input", render);
$("filter").addEventListener("change", render);

function matches(m, terms, category) {
	if (category && m.category !== category) return false;
	const text = `${m.title}\n${m.content}\n${m.category}`.toLowerCase();
	return terms.every((t) => text.includes(t));
}

function render() {
	const terms = $("search").value.toLowerCase().split(/\s+/).filter(Boolean);
	const category = $("filter").value;
	const shown = memories.filter((m) => matches(m, terms, category)).sort((a, b) => b.updated.localeCompare(a.updated));
	const total = `${memories.length} ${memories.length === 1 ? "memory" : "memories"}`;
	count("memories-count", String(memories.length));
	$("status").textContent =
		(shown.length === memories.length ? total : `Showing ${shown.length} of ${total}`) +
		(unreadable ? ` · ${unreadable} could not be decrypted` : "");
	$("list").replaceChildren(
		...shown.map(view),
		...(shown.length ? [] : [el("li", { class: "empty" }, memories.length ? "No memories match." : "No memories yet.")]),
	);
}

function view(m) {
	const item = el("li", { class: "memory" });
	const meta = el(
		"p",
		{ class: "meta" },
		el("span", { class: "chip" }, m.category),
		` Updated ${day(m.updated)}`,
		m.source ? ` · saved by ${m.source}` : "",
	);
	const history = m.history?.length
		? el(
				"details",
				{},
				el("summary", {}, `Earlier versions (${m.history.length})`),
				el("ul", {}, ...[...m.history].reverse().map((h) => el("li", {}, el("span", { class: "meta" }, `Until ${day(h.until)}: `), h.content))),
			)
		: null;
	const edit = el("button", { type: "button", class: "link" }, "Edit");
	edit.addEventListener("click", () => item.replaceWith(editor(m)));
	for (const part of [meta, titled(m) ? el("h3", {}, m.title) : null, el("p", { class: "content" }, m.content), history, edit]) {
		if (part) item.append(part);
	}
	return item;
}

// ---- Editing -------------------------------------------------------------------------------

function editor(m) {
	const isNew = !m;
	const form = el("form", { class: "memory editing", noValidate: true });
	const id = isNew ? "new" : m.id;
	const category = el("select", { id: `cat-${id}`, name: "category" }, ...CATEGORIES.map((c) => el("option", { value: c, selected: m?.category === c }, c)));
	if (isNew) category.value = "other";
	form.append(
		el("label", { htmlFor: `content-${id}` }, "Memory"),
		el("textarea", { id: `content-${id}`, name: "content", rows: 4, maxLength: MAX_CONTENT, required: true, value: m?.content ?? "" }),
		el("label", { htmlFor: `title-${id}` }, "Short label (optional)"),
		el("input", { id: `title-${id}`, name: "title", type: "text", maxLength: MAX_TITLE, value: m && titled(m) ? m.title : "" }),
		el("label", { htmlFor: `cat-${id}` }, "Category"),
		category,
	);
	if (!isNew) {
		form.append(el("p", { class: "note" }, "Changing the text keeps the current wording as an earlier version, so your AI can still tell what was true before."));
	}
	const error = el("p", { class: "error", role: "alert" });
	const save = el("button", { type: "submit" }, isNew ? "Save memory" : "Save");
	const cancel = el("button", { type: "button", class: "secondary" }, "Cancel");
	const actions = el("div", { class: "actions" }, save, cancel);
	if (!isNew) {
		const remove = el("button", { type: "button", class: "danger" }, "Delete");
		remove.addEventListener("click", () => removeMemory(m, form, error));
		actions.append(remove);
	}
	form.append(error, actions);

	cancel.addEventListener("click", () => (isNew ? form.remove() : form.replaceWith(view(m))));
	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		error.textContent = "";
		const content = form.elements.content.value.trim();
		const title = form.elements.title.value.trim();
		if (!content) return void (error.textContent = "Write the memory first.");
		if (looksLikeSecret(content) || looksLikeSecret(title)) {
			error.textContent = "This looks like a password, key or card number, which OwnMemory never stores.";
			return;
		}
		save.disabled = true;
		try {
			if (isNew) await create(content, title, form.elements.category.value);
			else await update(m, content, title, form.elements.category.value);
			render();
		} catch (e) {
			if (e instanceof SignInNeeded) return needSignIn();
			error.textContent = e.message || String(e);
			save.disabled = false;
		}
	});
	setTimeout(() => form.elements.content.focus());
	return form;
}

$("add").addEventListener("click", () => {
	if ($("new-memory").firstChild) return $("new-memory").querySelector("textarea").focus();
	$("new-memory").append(editor(null));
});

async function create(content, title, category) {
	const now = new Date().toISOString();
	const fields = { title: title || defaultTitle(content), category, content, source: "you", created: now, updated: now };
	const saved = await api("POST", "/memories/files", { body: await encryptMemory(key, toMarkdown(fields)) });
	memories.push({ id: saved.id, modified: saved.modified, ...fields });
	$("new-memory").replaceChildren();
}

async function update(m, content, title, category) {
	const nextTitle = title || defaultTitle(content);
	const changed = content !== m.content;
	if (!changed && nextTitle === m.title && category === m.category) return; // nothing to save
	const now = new Date().toISOString();
	const history = changed ? [...(m.history ?? []), { content: m.content, until: now }].slice(-HISTORY_LIMIT) : m.history;
	const next = { ...m, title: nextTitle, category, content, updated: now, ...(history ? { history } : {}) };
	const saved = await api("PUT", `/memories/files/${encodeURIComponent(m.id)}`, {
		body: await encryptMemory(key, toMarkdown(next)),
		modified: m.modified,
	});
	next.modified = saved.modified;
	memories[memories.indexOf(m)] = next;
}

async function removeMemory(m, form, error) {
	if (!confirm("Delete this memory? It can be restored for 30 days.")) return;
	try {
		await api("DELETE", `/memories/files/${encodeURIComponent(m.id)}`, { modified: m.modified });
		memories = memories.filter((x) => x !== m);
		form.remove();
		render();
	} catch (e) {
		if (e instanceof SignInNeeded) return needSignIn();
		error.textContent = e.message || String(e);
	}
}

start();
