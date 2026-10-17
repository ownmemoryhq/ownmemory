// The sign-in step on one-click servers, before the passphrase (see src/gate.ts): a passkey,
// or the owner code plus an authenticator code; on a server not yet set up, the owner code
// once, then a passkey or an authenticator app. Used by the Claude sign-in page and the
// memories page, which differ only in where they post and what comes next.
import { qrcode } from "/vendor/qrcode.mjs";

// ---- WebAuthn JSON <-> browser objects ----------------------------------------------------------

const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
function toB64url(buffer) {
	let s = "";
	for (const b of new Uint8Array(buffer)) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const passkeysSupported = () => typeof window.PublicKeyCredential === "function";

async function createPasskey(options) {
	const credential = await navigator.credentials.create({
		publicKey: {
			...options,
			challenge: fromB64url(options.challenge),
			user: { ...options.user, id: fromB64url(options.user.id) },
			excludeCredentials: (options.excludeCredentials ?? []).map((c) => ({ ...c, id: fromB64url(c.id) })),
		},
	});
	const r = credential.response;
	return {
		id: credential.id,
		rawId: toB64url(credential.rawId),
		type: credential.type,
		authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
		response: {
			clientDataJSON: toB64url(r.clientDataJSON),
			attestationObject: toB64url(r.attestationObject),
			transports: r.getTransports?.() ?? [],
		},
		clientExtensionResults: credential.getClientExtensionResults(),
	};
}

async function usePasskey(options) {
	const credential = await navigator.credentials.get({
		publicKey: {
			...options,
			challenge: fromB64url(options.challenge),
			allowCredentials: (options.allowCredentials ?? []).map((c) => ({ ...c, id: fromB64url(c.id) })),
		},
	});
	const r = credential.response;
	return {
		id: credential.id,
		rawId: toB64url(credential.rawId),
		type: credential.type,
		authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
		response: {
			clientDataJSON: toB64url(r.clientDataJSON),
			authenticatorData: toB64url(r.authenticatorData),
			signature: toB64url(r.signature),
			userHandle: r.userHandle ? toB64url(r.userHandle) : undefined,
		},
		clientExtensionResults: credential.getClientExtensionResults(),
	};
}

/** Readable messages for the errors the browser's passkey prompt gives. */
function passkeyError(error) {
	if (error?.name === "NotAllowedError") return new Error("The passkey prompt was closed or timed out. Try again.");
	if (error?.name === "InvalidStateError") return new Error("This device already has a passkey for this server.");
	if (error?.name === "SecurityError") return new Error("Passkeys don't work on this address. Open the server's own address.");
	return error;
}

// ---- Small helpers -----------------------------------------------------------------------------

function el(tag, props = {}, ...children) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === "class") node.className = v;
		else if (k in node) node[k] = v;
		else node.setAttribute(k, v);
	}
	for (const child of children) if (child != null && child !== false) node.append(child);
	return node;
}

export class SignInNeeded extends Error {}

async function post(url, body) {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
	const result = await response.json().catch(() => ({}));
	if (response.status === 401 && result.signIn) throw new SignInNeeded(result.error);
	if (!response.ok) throw new Error(result.error || "Something went wrong. Try again.");
	return result;
}

/** Runs an action from a button or form, showing progress and errors in place. */
async function busy(button, label, error, action) {
	const original = button.textContent;
	error.textContent = "";
	button.disabled = true;
	button.textContent = label;
	try {
		return await action();
	} catch (e) {
		if (e instanceof SignInNeeded) throw e;
		error.textContent = e.message || String(e);
	} finally {
		button.disabled = false;
		button.textContent = original;
	}
}

/** The QR code, setup key and confirmation field for adding an authenticator app. */
function totpSetup({ secret, uri }, onCode) {
	const qr = qrcode(0, "M");
	qr.addData(uri);
	qr.make();
	const code = el("input", { id: "totp-confirm", name: "code", type: "text", inputMode: "numeric", autocomplete: "one-time-code", maxLength: 6, required: true });
	const error = el("p", { class: "error", role: "alert" });
	const submit = el("button", { type: "submit" }, "Confirm");
	const form = el(
		"form",
		{ noValidate: true },
		el("p", {}, "Scan this with your authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…), or enter the setup key by hand."),
		el("img", { class: "qr", src: qr.createDataURL(5, 8), alt: "QR code for your authenticator app", width: 220, height: 220 }),
		el("p", { class: "note" }, "Setup key: ", el("span", { class: "mono setup-key" }, secret.replace(/(.{4})/g, "$1 ").trim())),
		el("p", { class: "note" }, el("a", { href: uri }, "Open in an authenticator app on this device")),
		el("label", { htmlFor: "totp-confirm" }, "Then enter the 6-digit code it shows"),
		code,
		error,
		el("div", { class: "actions" }, submit),
	);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		busy(submit, "Checking…", error, () => onCode(code.value.trim()));
	});
	setTimeout(() => code.focus());
	return form;
}

// ---- Signing in --------------------------------------------------------------------------------

/**
 * Shows the sign-in step in panel and resolves with the server's answer once it passes.
 * base: "/gate/connect" or "/memories/gate"; extra: fields every request carries (the handle).
 */
export function signIn(panel, base, extra = {}) {
	return new Promise((resolve, reject) => {
		const call = (path, body) => post(`${base}${path}`, { ...extra, ...body });
		const done = (result) => resolve(result);
		const render = (...children) => {
			panel.replaceChildren(...children);
			panel.querySelector("input, button")?.focus();
		};
		const guard = (fn) => (...args) => fn(...args).catch(reject);

		// Claimed server: owner code plus authenticator code.
		function codesForm(extraNote) {
			const owner = el("input", { id: "gate-owner", name: "code", type: "password", autocomplete: "current-password", required: true });
			const totp = el("input", { id: "gate-totp", name: "totp", type: "text", inputMode: "numeric", autocomplete: "one-time-code", maxLength: 6, required: true });
			const error = el("p", { class: "error", role: "alert" });
			const submit = el("button", { type: "submit" }, "Continue");
			const form = el(
				"form",
				{ noValidate: true },
				el("label", { htmlFor: "gate-owner" }, "Owner code"),
				owner,
				el("label", { htmlFor: "gate-totp" }, "Code from your authenticator app"),
				totp,
				error,
				el("div", { class: "actions" }, submit),
				extraNote,
			);
			form.addEventListener(
				"submit",
				guard(async (event) => {
					event.preventDefault();
					await busy(submit, "Checking…", error, async () => {
						const result = await call("/owner", { code: owner.value, totp: totp.value.trim() });
						owner.value = "";
						done(result);
					});
				}),
			);
			return form;
		}

		function passkeyButton(options) {
			const error = el("p", { class: "error", role: "alert" });
			const button = el("button", { type: "button" }, "Sign in with a passkey");
			button.addEventListener(
				"click",
				guard(async () => {
					await busy(button, "Waiting for your passkey…", error, async () => {
						let response;
						try {
							response = await usePasskey(options);
						} catch (e) {
							throw passkeyError(e);
						}
						try {
							done(await call("/passkey", { response }));
						} catch (e) {
							// A challenge is used once: fetch a fresh one for the next try.
							options = (await call("/start")).options ?? options;
							throw e;
						}
					});
				}),
			);
			return { button, error };
		}

		function showClaimed(start) {
			const parts = [el("h1", {}, "Sign in")];
			if (start.passkey && passkeysSupported()) {
				const { button, error } = passkeyButton(start.options);
				parts.push(el("p", {}, "Use the passkey you set up for this server: Face ID, a fingerprint, Windows Hello, or your phone."));
				parts.push(el("div", { class: "actions" }, button), error);
				if (start.totp) {
					const other = el("button", { type: "button", class: "link" }, "Use your authenticator app instead");
					other.addEventListener("click", () => render(el("h1", {}, "Sign in"), codesForm()));
					parts.push(el("p", {}, other));
				}
			} else if (start.totp) {
				parts.push(el("p", {}, "Enter your owner code and the 6-digit code from your authenticator app."), codesForm());
			} else {
				parts.push(el("p", { class: "error" }, "This browser can't use passkeys. Open this page in a current browser, or on your phone."));
			}
			render(...parts);
		}

		// Unclaimed server: the owner code once, then set up a method.
		function showClaim() {
			const owner = el("input", { id: "gate-owner", name: "code", type: "password", autocomplete: "current-password", required: true });
			const error = el("p", { class: "error", role: "alert" });
			const submit = el("button", { type: "submit" }, "Continue");
			const form = el("form", { noValidate: true }, el("label", { htmlFor: "gate-owner" }, "Owner code"), owner, error, el("div", { class: "actions" }, submit));
			form.addEventListener(
				"submit",
				guard(async (event) => {
					event.preventDefault();
					await busy(submit, "Checking…", error, async () => {
						const result = await call("/owner", { code: owner.value });
						owner.value = "";
						showEnroll(result.options);
					});
				}),
			);
			render(
				el("h1", {}, "Enter your owner code"),
				el("p", {}, "The code you chose when you deployed this server. You need it once, to protect the server with a passkey or an authenticator app."),
				form,
			);
		}

		function showEnroll(options) {
			const error = el("p", { class: "error", role: "alert" });
			const passkey = el("button", { type: "button" }, "Add a passkey");
			const app = el("button", { type: "button", class: "secondary" }, "Use an authenticator app");
			passkey.disabled = !passkeysSupported();
			passkey.addEventListener(
				"click",
				guard(async () => {
					await busy(passkey, "Waiting for your device…", error, async () => {
						let response;
						try {
							response = await createPasskey(options);
						} catch (e) {
							throw passkeyError(e);
						}
						done(await call("/enroll/passkey", { response }));
					});
				}),
			);
			app.addEventListener(
				"click",
				guard(async () => {
					await busy(app, "Preparing…", error, async () => {
						const setup = await call("/enroll/totp");
						render(
							el("h1", {}, "Add an authenticator app"),
							totpSetup(setup, async (code) => done(await call("/enroll/totp/confirm", { code }))),
							el(
								"p",
								{ class: "note" },
								"From now on you'll sign in with your owner code plus a code from this app. Keep your owner code in your password manager.",
							),
						);
					});
				}),
			);
			render(
				el("h1", {}, "Protect your server"),
				el("p", {}, "Choose how you'll sign in from now on. The owner code alone will no longer be enough."),
				el(
					"ul",
					{ class: "choices" },
					el("li", {}, el("strong", {}, "Passkey (recommended): "), "one tap with Face ID, a fingerprint, Windows Hello or your phone. Nothing to type or guess."),
					el("li", {}, el("strong", {}, "Authenticator app: "), "your owner code plus a 6-digit code from an app on your phone."),
				),
				el("div", { class: "actions" }, passkey, app),
				error,
				el("p", { class: "note" }, "You can add more passkeys, or both methods, later on the memories page."),
			);
		}

		render(el("p", { class: "note" }, "Checking this server…"));
		call("/start")
			.then((start) => (start.claimed ? showClaimed(start) : showClaim()))
			.catch(reject);
	});
}

// ---- Managing methods on the memories page ---------------------------------------------------------

const day = (iso) => (iso ? iso.slice(0, 10) : "");

/** The "Sign-in methods" card: list, add and remove passkeys and the authenticator app. */
export async function manage(container, onSignInNeeded, onCount) {
	const base = "/memories/security";
	const error = el("p", { class: "error", role: "alert" });

	async function request(method, path = "", body) {
		const response = await fetch(base + path, {
			method,
			headers: body === undefined ? {} : { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const result = await response.json().catch(() => ({}));
		if (response.status === 401 && result.signIn) throw new SignInNeeded(result.error);
		if (!response.ok) throw new Error(result.error || "Something went wrong. Try again.");
		return result;
	}

	const run = (fn) => async (...args) => {
		error.textContent = "";
		try {
			await fn(...args);
		} catch (e) {
			if (e instanceof SignInNeeded) return onSignInNeeded();
			error.textContent = passkeyError(e).message || String(e);
		}
	};

	function render(methods, extra) {
		const list = el("ul", { class: "methods" });
		for (const p of methods.passkeys) {
			const remove = el("button", { type: "button", class: "link" }, "Remove");
			remove.addEventListener(
				"click",
				run(async () => {
					if (!confirm(`Remove the passkey "${p.name}"? You won't be able to sign in with it any more.`)) return;
					render(await request("DELETE", `/passkey/${encodeURIComponent(p.id)}`, {}));
				}),
			);
			list.append(
				el("li", {}, el("span", {}, el("strong", {}, `Passkey · ${p.name}`), el("br"), el("span", { class: "note" }, `Added ${day(p.created)}${p.lastUsed ? ` · last used ${day(p.lastUsed)}` : ""}`)), remove),
			);
		}
		if (methods.totp) {
			const remove = el("button", { type: "button", class: "link" }, "Remove");
			remove.addEventListener(
				"click",
				run(async () => {
					if (!confirm("Remove the authenticator app? You'll sign in with a passkey only.")) return;
					render(await request("DELETE", "/totp", {}));
				}),
			);
			list.append(el("li", {}, el("span", {}, el("strong", {}, "Authenticator app"), el("br"), el("span", { class: "note" }, `Added ${day(methods.totp.created)} · used with your owner code`)), remove));
		}

		const addPasskey = el("button", { type: "button", class: "secondary" }, "Add a passkey");
		addPasskey.disabled = !passkeysSupported();
		addPasskey.addEventListener(
			"click",
			run(async () => {
				const options = await request("POST", "/passkey/options", {});
				let response;
				try {
					response = await createPasskey(options);
				} catch (e) {
					throw passkeyError(e);
				}
				render(await request("POST", "/passkey", { response }));
			}),
		);
		const addTotp = el("button", { type: "button", class: "secondary" }, methods.totp ? "Replace authenticator app" : "Add an authenticator app");
		addTotp.addEventListener(
			"click",
			run(async () => {
				const setup = await request("POST", "/totp", {});
				render(methods, totpSetup(setup, async (code) => render(await request("POST", "/totp/confirm", { code }))));
			}),
		);

		onCount?.(methods.passkeys.length + (methods.totp ? 1 : 0));
		const parts = [
			container.dataset.bare ? null : el("h2", {}, "Sign-in methods"),
			el("p", { class: "note" }, "How you sign in to this server, before your passphrase. Add a passkey on each device you use, or one in your password manager."),
			list,
			error,
			extra ?? el("div", { class: "actions" }, addPasskey, addTotp),
		];
		container.replaceChildren(...parts.filter(Boolean));

	}

	try {
		render(await request("GET"));
	} catch (e) {
		if (e instanceof SignInNeeded) return onSignInNeeded();
		container.replaceChildren(el("p", { class: "error" }, e.message));
	}
}
