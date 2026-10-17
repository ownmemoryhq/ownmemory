// The sign-in flow Claude starts when the connector is added. Two storage modes:
//   Drive (STORAGE unset or "drive"): consent → Google sign-in (/callback) → passphrase page
//   D1 (STORAGE="d1", the one-click default): consent → passkey or codes (gate.ts) → passphrase page
// Both end at POST /unlock, which receives the memory key and completes the OAuth grant.
import {
	AuthorizationError,
	type AuthRequest,
	CimdFetchError,
	type OAuthHelpers,
	authorizationErrorRedirect,
} from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { assertKeyInfo, checkMemoryKey, fromB64, toB64 } from "../public/keys.js";
import { DRIVE_SCOPE, Drive, DriveError, exchangeCode, googleAuthorizeUrl, readIdToken } from "./google";
import { consentPage, errorPage, homePage, htmlResponse, memoriesPage, privacyPage, unlockPage } from "./pages";
import type { Props } from "./props";
import { type GateState, gateRoutes } from "./gate";
import { finishPageSignIn, isPageSignIn, memoriesApp } from "./memories";
import { DriveStorage, type Storage, readKeyInfo, writeKeyInfo } from "./storage";
import {
	UserFacingError,
	allowedEmails,
	b64url,
	cookie,
	d1,
	dropState,
	newHandle,
	openState,
	ownerCodeHash,
	ownerCodeTag,
	randomVerifier,
	readCookie,
	sealState,
	sha256,
	usesD1,
} from "./web";

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };
const app = new Hono<{ Bindings: Bindings }>();

const UNLOCK_COOKIE = "__Host-ownmemory-unlock";
const UNLOCK_TTL = 600;

const origin = (env: Env, request: Request) => env.PUBLIC_URL || new URL(request.url).origin;

function callbackUrl(request: Request) {
	return new URL("/callback", request.url).href;
}

function redirect(location: string, headers = new Headers()) {
	headers.set("Location", location);
	return new Response(null, { status: 302, headers });
}

// Between sign-in and the passphrase page, the sign-in state waits in KV for at most ten
// minutes, sealed with the handle in the browser's cookie (see web.ts).
interface Pending {
	request: AuthRequest;
	storage: Props["storage"];
	email: string;
	sub: string;
	/** D1: the sign-in step in progress, then set once it passed. */
	gate?: GateState;
	verified?: boolean;
	folderId?: string;
	google?: Props["google"];
}

const savePending = (kv: KVNamespace, handle: string, pending: Pending) => sealState(kv, "unlock", handle, pending, UNLOCK_TTL);

async function stashPending(kv: KVNamespace, pending: Pending) {
	const handle = newHandle();
	await savePending(kv, handle, pending);
	return { handle, cookie: cookie(UNLOCK_COOKIE, handle, UNLOCK_TTL) };
}

async function loadPending(kv: KVNamespace, handle: string): Promise<Pending | null> {
	const pending = await openState<Pending>(kv, "unlock", handle);
	return pending && { ...pending, storage: pending.storage ?? "drive" };
}

const dropPending = (kv: KVNamespace, handle: string) => dropState(kv, "unlock", handle);

const expired = () =>
	new UserFacingError("This page expired", "Go back to Claude and connect OwnMemory again. Nothing was changed.");

app.get("/", (c) => htmlResponse(homePage(origin(c.env, c.req.raw), usesD1(c.env))));
app.get("/privacy", (c) => htmlResponse(privacyPage(origin(c.env, c.req.raw), usesD1(c.env))));
// The old "Download my memories" page; downloading now happens on the memories page.
app.get("/export", (c) => c.redirect("/memories", 301));
app.get("/memories", (c) => htmlResponse(memoriesPage(usesD1(c.env))));
app.route("/memories", memoriesApp);

app.get("/authorize", async (c) => {
	const oauth = c.env.OAUTH_PROVIDER;
	const request = await oauth.parseAuthRequest(c.req.raw);
	const details = await oauth.describeConsent(request);
	const consent = await oauth.beginConsent(request);
	return htmlResponse(consentPage(details, consent.handle, usesD1(c.env)), consent.headers);
});

app.post("/authorize", async (c) => {
	const oauth = c.env.OAUTH_PROVIDER;
	const form = await c.req.raw.formData();
	const handle = String(form.get("handle") ?? "");
	if (form.get("decision") !== "approve") {
		const denied = await oauth.denyConsent(c.req.raw, handle);
		return new Response(null, { status: 302, headers: denied.headers });
	}
	const approved = await oauth.approveConsent(c.req.raw, handle);

	if (usesD1(c.env)) {
		// No third party to sign in with: the owner code (next page) proves who is connecting.
		const pending = await stashPending(c.env.OAUTH_KV, {
			request: approved.request,
			storage: "d1",
			email: "",
			sub: "owner",
		});
		approved.headers.append("Set-Cookie", pending.cookie);
		return htmlResponse(unlockPage({ mode: "gate", email: "", handle: pending.handle, keyinfo: null }), approved.headers);
	}

	const verifier = randomVerifier();
	const { state, headers } = await oauth.beginUpstream(approved.request, {
		data: { verifier },
		headers: approved.headers,
	});
	const challenge = b64url(await sha256(verifier));
	return redirect(googleAuthorizeUrl(c.env, callbackUrl(c.req.raw), state, challenge), headers);
});

// D1 mode: the sign-in step (gate.ts) runs between consent and the passphrase. Only once it
// passes does the page get the wrapped key, so nobody else can download it to guess passphrases.
gateRoutes(app, "/gate/connect", async (c, body) => {
	if (!usesD1(c.env)) return null;
	const kv = c.env.OAUTH_KV as KVNamespace;
	const handle = readCookie(c.req.raw, UNLOCK_COOKIE);
	if (!handle || body.handle !== handle) return null;
	const pending = await loadPending(kv, handle);
	if (!pending || pending.storage !== "d1") return null;
	return {
		state: pending.gate ?? {},
		save: (gate) => savePending(kv, handle, { ...pending, gate }),
		pass: async () => {
			await savePending(kv, handle, { ...pending, gate: undefined, verified: true });
			const existing = await readKeyInfo(d1(c.env));
			if (existing) assertKeyInfo(existing.keyinfo);
			return c.json({ mode: existing ? "unlock" : "create", keyinfo: existing?.keyinfo ?? null });
		},
	};
});

app.get("/callback", async (c) => {
	// The memories page signs in with Google through the same redirect URI.
	if (isPageSignIn(c.req.raw)) return finishPageSignIn(c.env, c.req.raw);
	const oauth = c.env.OAUTH_PROVIDER;
	const { request, data, headers } = await oauth.finishUpstream<{ verifier: string; askedForDrive?: boolean }>(c.req.raw);
	const url = new URL(c.req.url);
	const code = url.searchParams.get("code");
	if (url.searchParams.get("error") || !code) {
		return redirect(authorizationErrorRedirect(request, "access_denied"), headers);
	}

	const tokens = await exchangeCode(c.env, code, data.verifier, callbackUrl(c.req.raw));
	const identity = readIdToken(tokens.idToken);
	const allowed = allowedEmails(c.env);
	if (!identity.emailVerified || !allowed.includes(identity.email)) {
		throw new UserFacingError(
			"This account can't use this server",
			allowed.length
				? `${identity.email} is not on this server's list of allowed accounts.`
				: "The server's owner hasn't set ALLOWED_EMAILS yet, so nobody can connect.",
			403,
		);
	}
	if (!tokens.refreshToken) {
		throw new UserFacingError(
			"Google didn't grant offline access",
			"Remove OwnMemory at myaccount.google.com/permissions, then connect again from Claude.",
		);
	}

	if (!tokens.scope.split(" ").includes(DRIVE_SCOPE)) {
		// Google lists Drive as a separate checkbox on a first sign-in, easy to miss. Ask once
		// more for Drive alone, which Google shows as one clear screen; then give up with a message.
		if (!data.askedForDrive) {
			const verifier = randomVerifier();
			const retry = await oauth.beginUpstream(request, { data: { verifier, askedForDrive: true }, headers });
			const challenge = b64url(await sha256(verifier));
			const url = googleAuthorizeUrl(c.env, callbackUrl(c.req.raw), retry.state, challenge, { driveOnly: { email: identity.email } });
			return redirect(url, retry.headers);
		}
		throw new UserFacingError(
			"Google Drive access wasn't granted",
			"OwnMemory needs access to the Drive files it creates. Connect again from Claude, and on Google's screen tick the box for Google Drive files.",
		);
	}

	const drive = new Drive(tokens.accessToken);
	const folderId = await drive.ensureFolder();
	const existing = await readKeyInfo(new DriveStorage(drive, folderId));
	if (existing) assertKeyInfo(existing.keyinfo);

	const { handle, cookie } = await stashPending(c.env.OAUTH_KV, {
		request,
		storage: "drive",
		email: identity.email,
		sub: identity.sub,
		folderId,
		google: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt },
	});
	headers.append("Set-Cookie", cookie);
	const page = unlockPage({
		mode: existing ? "unlock" : "create",
		email: identity.email,
		handle,
		keyinfo: existing?.keyinfo,
	});
	return htmlResponse(page, headers);
});

app.post("/unlock", async (c) => {
	const form = await c.req.raw.formData();
	const handle = readCookie(c.req.raw, UNLOCK_COOKIE);
	// The handle must arrive both as the SameSite=Strict cookie and in the form.
	if (!handle || form.get("handle") !== handle) throw expired();
	const pending = await loadPending(c.env.OAUTH_KV, handle);
	if (!pending) throw expired();

	let storage: Storage;
	if (pending.storage === "d1") {
		if (!pending.verified) throw expired();
		storage = d1(c.env);
	} else {
		if (!pending.google || !pending.folderId) throw expired();
		storage = new DriveStorage(new Drive(pending.google.accessToken), pending.folderId);
	}

	const mode = String(form.get("mode"));
	const memoryKey = fromB64(String(form.get("memoryKey") ?? ""));
	if (memoryKey.length !== 32) throw new UserFacingError("Something went wrong", "The key was not received. Try again.");
	const posted = form.get("keyinfo") ? JSON.parse(String(form.get("keyinfo"))) : null;
	const existing = await readKeyInfo(storage);

	if (mode === "create") {
		if (existing) {
			throw new UserFacingError("A memory key already exists", "Connect again from Claude and unlock it instead.");
		}
		assertKeyInfo(posted);
		if (!(await checkMemoryKey(posted, memoryKey))) throw new UserFacingError("Key mismatch", "Try again.");
		await writeKeyInfo(storage, posted);
	} else if (mode === "unlock" || mode === "recover") {
		if (!existing) throw expired();
		assertKeyInfo(existing.keyinfo);
		if (!(await checkMemoryKey(existing.keyinfo, memoryKey))) {
			throw new UserFacingError("That key doesn't match", "Connect again from Claude and re-enter your passphrase.");
		}
		if (mode === "recover") {
			assertKeyInfo(posted);
			if (!(await checkMemoryKey(posted, memoryKey))) throw new UserFacingError("Key mismatch", "Try again.");
			await writeKeyInfo(storage, posted, existing.id);
		}
	} else {
		throw expired();
	}

	const props: Props = {
		storage: pending.storage,
		email: pending.email,
		sub: pending.sub,
		memoryKey: toB64(memoryKey),
		...(pending.storage === "drive" ? { folderId: pending.folderId, google: pending.google } : { ownerCode: await ownerCodeHash(c.env) }),
	};
	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		request: pending.request,
		userId: encodeURIComponent(pending.sub),
		// D1: which owner code this connection belongs to, so the memories page can drop dead ones.
		metadata: { label: pending.email || "owner", ...(pending.storage === "d1" ? { ownerCode: await ownerCodeTag(c.env) } : {}) },
		scope: pending.request.scope,
		props,
	});
	await dropPending(c.env.OAUTH_KV, handle);
	const headers = new Headers();
	headers.append("Set-Cookie", cookie(UNLOCK_COOKIE, "", 0));
	return redirect(redirectTo, headers);
});

app.onError((error) => {
	if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
	if (error instanceof AuthorizationError) {
		return htmlResponse(errorPage("This sign-in link is no longer valid", error.description), undefined, 400);
	}
	if (error instanceof CimdFetchError) {
		return htmlResponse(errorPage("This app could not be verified", "Try connecting again."), undefined, 400);
	}
	if (error instanceof UserFacingError) {
		return htmlResponse(errorPage(error.title, error.message), undefined, error.status);
	}
	if (error instanceof DriveError && error.status === 403) {
		return htmlResponse(
			errorPage(
				"Google Drive refused the request",
				"Check that the Google Drive API is enabled in your Google Cloud project, then connect again from Claude.",
			),
			undefined,
			502,
		);
	}
	// Log the error kind only: messages could echo request data. Our own errors carry no content.
	const detail = error instanceof DriveError ? `DriveError ${error.status}` : error instanceof Error ? error.name : typeof error;
	console.error("auth error", detail);
	return htmlResponse(
		errorPage("Something went wrong", "Try connecting again from Claude in a minute."),
		undefined,
		500,
	);
});

export { app as AuthHandler };
