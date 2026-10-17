// The memories page (/memories): browse, search, edit, add, delete and download memories in
// the browser. It decrypts and encrypts on the device: these routes move ciphertext only, so
// the server never sees a memory or the passphrase here either.
//
// Opening the page takes the same two steps as connecting Claude: a passkey or codes (D1,
// see gate.ts) or a Google sign-in (Drive), then the passphrase, which the browser alone uses. The first step
// starts a session of at most an hour, kept in KV sealed with a handle in an HttpOnly cookie.
//
// Edits leave the search index alone: an edited memory's "updated" time no longer matches its
// embedding, so the next search recomputes it, and deleted memories are pruned the same way.
import type { GrantSummary, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { assertKeyInfo } from "../public/keys.js";
import { type GateState, gateRoutes, manageRoutes } from "./gate";
import { DRIVE_SCOPE, Drive, DriveError, exchangeCode, googleAuthorizeUrl, readIdToken } from "./google";
import { DriveStorage, type Storage, readKeyInfo } from "./storage";
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

const SESSION_COOKIE = "__Host-ownmemory-session";
const SESSION_TTL = 3600;
const SIGNIN_COOKIE = "__Host-ownmemory-signin";
const SIGNIN_TTL = 600;
const MAX_FILE = 100_000;

interface Session {
	storage: "d1" | "drive";
	email: string;
	/** Drive: the Google account id, which Claude's connections are filed under. */
	sub?: string;
	expiresAt: number;
	folderId?: string;
	accessToken?: string;
	/** A passkey challenge or authenticator secret while adding one on the page. */
	gate?: GateState;
	/** D1: the owner code the session was opened under; changing OWNER_CODE ends it. */
	ownerCode?: string | null;
}

/** A session needs a fresh sign-in: the page asks for the owner code or Google again. */
class SignInNeeded extends Error {}

async function loadSession(env: Env, request: Request): Promise<Session> {
	const handle = readCookie(request, SESSION_COOKIE);
	const session = handle ? await openState<Session>(env.OAUTH_KV, "session", handle) : null;
	if (!session || session.expiresAt < Date.now()) throw new SignInNeeded();
	if (session.storage === "d1" && session.ownerCode !== (await ownerCodeHash(env))) throw new SignInNeeded();
	return session;
}

async function startSession(env: Env, session: Session) {
	const handle = newHandle();
	const ttl = Math.floor((session.expiresAt - Date.now()) / 1000);
	await sealState(env.OAUTH_KV, "session", handle, session, ttl);
	return cookie(SESSION_COOKIE, handle, ttl);
}

function storageFor(env: Env, session: Session): Storage {
	if (session.storage === "d1") return d1(env);
	if (!session.accessToken || !session.folderId) throw new SignInNeeded();
	return new DriveStorage(new Drive(session.accessToken), session.folderId);
}

/** Checks a posted .omem file looks like ciphertext; its content stays unreadable here. */
function encryptedBody(value: unknown): string {
	if (typeof value !== "string" || value.length > MAX_FILE) throw new UserFacingError("Bad request", "Missing file.");
	const box = JSON.parse(value);
	if (box?.ownmemory !== 1 || typeof box.iv !== "string" || typeof box.ct !== "string") {
		throw new UserFacingError("Bad request", "That isn't an encrypted memory.");
	}
	return value;
}

const memoriesApp = new Hono<{ Bindings: Env }>();

// Changes arrive only as JSON from this origin: with the SameSite=Strict cookie, other sites
// can neither send them nor ride on the session.
memoriesApp.use("*", async (c, next) => {
	if (c.req.method === "GET") return next();
	const sameOrigin = (c.req.header("Sec-Fetch-Site") ?? "same-origin") === "same-origin";
	if (!sameOrigin || !c.req.header("Content-Type")?.startsWith("application/json")) {
		return c.json({ error: "Not allowed." }, 403);
	}
	return next();
});

// D1: the sign-in step (passkey, or owner code plus authenticator code) opens a session.
// While it runs, its state waits in KV under its own short-lived cookie.
const GATE_COOKIE = "__Host-ownmemory-gate";
const GATE_TTL = 600;

gateRoutes(memoriesApp, "/gate", async (c, _body, starting) => {
	if (!usesD1(c.env)) return null;
	const kv = c.env.OAUTH_KV as KVNamespace;
	let handle = readCookie(c.req.raw, GATE_COOKIE);
	let state = handle ? await openState<GateState>(kv, "gate", handle) : null;
	if (!state) {
		if (!starting) return null;
		handle = newHandle();
		state = {};
		c.header("Set-Cookie", cookie(GATE_COOKIE, handle, GATE_TTL), { append: true });
	}
	const gateHandle = handle!;
	return {
		state,
		save: (next) => sealState(kv, "gate", gateHandle, next, GATE_TTL),
		pass: async () => {
			await dropState(kv, "gate", gateHandle);
			c.header("Set-Cookie", cookie(GATE_COOKIE, "", 0), { append: true });
			const session: Session = {
				storage: "d1",
				email: "",
				expiresAt: Date.now() + SESSION_TTL * 1000,
				ownerCode: await ownerCodeHash(c.env),
			};
			c.header("Set-Cookie", await startSession(c.env, session), { append: true });
			return c.json({ ok: true });
		},
	};
});

// D1: add and remove passkeys and the authenticator app while signed in.
manageRoutes(memoriesApp, "/security", async (c) => {
	if (!usesD1(c.env)) return null;
	const handle = readCookie(c.req.raw, SESSION_COOKIE);
	if (!handle) return null;
	const session = await loadSession(c.env, c.req.raw).catch(() => null);
	if (!session) return null;
	return {
		state: session.gate ?? {},
		save: (gate) => sealState(c.env.OAUTH_KV, "session", handle, { ...session, gate }, (session.expiresAt - Date.now()) / 1000),
	};
});

// Drive: Google sign-in, through the server's usual /callback.
memoriesApp.get("/google", async (c) => {
	if (usesD1(c.env)) return c.redirect("/memories");
	const state = newHandle();
	const verifier = randomVerifier();
	const challenge = b64url(await sha256(verifier));
	const url = googleAuthorizeUrl(c.env, new URL("/callback", c.req.url).href, state, challenge, { online: true });
	// Lax: Google's redirect back to /callback is a cross-site navigation, which drops Strict
	// cookies. It holds only this sign-in's state and PKCE verifier, for ten minutes.
	c.header("Set-Cookie", cookie(SIGNIN_COOKIE, `${state}.${verifier}`, SIGNIN_TTL, "Lax"));
	return c.redirect(url);
});

function pageSignIn(request: Request) {
	const [state, verifier] = (readCookie(request, SIGNIN_COOKIE) ?? "").split(".");
	return state && verifier ? { state, verifier } : null;
}

/** Whether a /callback request belongs to the memories page's sign-in rather than Claude's. */
export function isPageSignIn(request: Request) {
	const started = pageSignIn(request);
	return !!started && new URL(request.url).searchParams.get("state") === started.state;
}

export async function finishPageSignIn(env: Env, request: Request): Promise<Response> {
	const { verifier } = pageSignIn(request)!;
	const url = new URL(request.url);
	const headers = new Headers({ Location: "/memories" });
	headers.append("Set-Cookie", cookie(SIGNIN_COOKIE, "", 0, "Lax"));
	const code = url.searchParams.get("code");
	if (url.searchParams.get("error") || !code) return new Response(null, { status: 302, headers });

	const tokens = await exchangeCode(env, code, verifier, new URL("/callback", request.url).href);
	const identity = readIdToken(tokens.idToken);
	if (!identity.emailVerified || !allowedEmails(env).includes(identity.email)) {
		throw new UserFacingError("This account can't use this server", `${identity.email} is not on this server's list of allowed accounts.`, 403);
	}
	if (!tokens.scope.split(" ").includes(DRIVE_SCOPE)) {
		throw new UserFacingError(
			"Google Drive access wasn't granted",
			"The memories page needs access to the Drive files OwnMemory creates. Open it again and tick the box for Google Drive files.",
		);
	}
	const folderId = await new Drive(tokens.accessToken).ensureFolder();
	headers.append(
		"Set-Cookie",
		await startSession(env, {
			storage: "drive",
			email: identity.email,
			sub: identity.sub,
			folderId,
			accessToken: tokens.accessToken,
			// A minute short of Google's expiry, so a request never starts with a dead token.
			expiresAt: Math.min(Date.now() + SESSION_TTL * 1000, tokens.expiresAt - 60_000),
		}),
	);
	return new Response(null, { status: 302, headers });
}

// Everything the page needs to show the memories, as ciphertext.
memoriesApp.get("/files", async (c) => {
	const session = await loadSession(c.env, c.req.raw);
	const storage = storageFor(c.env, session);
	const keyinfo = await readKeyInfo(storage);
	if (!keyinfo) return c.json({ error: "No memories yet: connect Claude first.", noKey: true }, 404);
	assertKeyInfo(keyinfo.keyinfo);
	const refs = await storage.list("memory");
	const files = await Promise.all(refs.map(async (f) => ({ id: f.id, modified: f.modifiedTime, body: await storage.read(f.id) })));
	return c.json({ keyinfo: keyinfo.keyinfo, email: session.email, files });
});

function writesPaused(env: Env) {
	return env.WRITES_PAUSED === "true" ? "Changes are paused on this server (WRITES_PAUSED). Nothing was changed." : null;
}

memoriesApp.post("/files", async (c) => {
	const paused = writesPaused(c.env);
	if (paused) return c.json({ error: paused }, 403);
	const storage = storageFor(c.env, await loadSession(c.env, c.req.raw));
	const body = encryptedBody((await c.req.json<{ body?: unknown }>()).body);
	const name = `${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("")}.omem`;
	const file = await storage.create("memory", name, body);
	return c.json({ id: file.id, modified: file.modifiedTime });
});

/** The memory, if it still exists and nobody (Claude, another tab) changed it since the page loaded. */
async function current(storage: Storage, id: string, modified: unknown) {
	const file = await storage.find(id, "memory");
	if (!file) return { error: "This memory no longer exists. Reload the page.", status: 404 as const };
	if (modified !== file.modifiedTime) {
		return { error: "This memory changed since the page loaded, for example in a chat. Reload the page to see it.", status: 409 as const };
	}
	return null;
}

memoriesApp.put("/files/:id", async (c) => {
	const paused = writesPaused(c.env);
	if (paused) return c.json({ error: paused }, 403);
	const storage = storageFor(c.env, await loadSession(c.env, c.req.raw));
	const posted = await c.req.json<{ body?: unknown; modified?: unknown }>();
	const stale = await current(storage, c.req.param("id"), posted.modified);
	if (stale) return c.json({ error: stale.error }, stale.status);
	const file = await storage.update(c.req.param("id"), encryptedBody(posted.body));
	return c.json({ modified: file.modifiedTime });
});

memoriesApp.delete("/files/:id", async (c) => {
	const paused = writesPaused(c.env);
	if (paused) return c.json({ error: paused }, 403);
	const storage = storageFor(c.env, await loadSession(c.env, c.req.raw));
	const posted = await c.req.json<{ modified?: unknown }>();
	const stale = await current(storage, c.req.param("id"), posted.modified);
	if (stale) return c.json({ error: stale.error }, stale.status);
	await storage.remove(c.req.param("id"));
	return c.json({ ok: true });
});

// Apps connected to this server (Claude on each account or device), and disconnecting them.
// Disconnecting deletes the connection and its tokens, unlocked memory key included.
function connectionsUser(session: Session) {
	if (session.storage === "d1") return "owner";
	if (!session.sub) throw new SignInNeeded(); // a session from before connections were listed
	return encodeURIComponent(session.sub);
}

async function appName(oauth: OAuthHelpers, clientId: string) {
	const client = await oauth.lookupClient(clientId).catch(() => null);
	if (client?.clientName) return client.clientName;
	try {
		return new URL(clientId).hostname;
	} catch {
		return "An app";
	}
}

memoriesApp.get("/connections", async (c) => {
	const user = connectionsUser(await loadSession(c.env, c.req.raw));
	const oauth = (c.env as Env & { OAUTH_PROVIDER: OAuthHelpers }).OAUTH_PROVIDER;
	const grants: GrantSummary[] = [];
	let cursor: string | undefined;
	do {
		const page = await oauth.listUserGrants(user, { cursor });
		grants.push(...page.items);
		cursor = page.cursor;
	} while (cursor);
	// D1: connections made under an earlier owner code (or before connections were labelled
	// with one) already can't do anything; remove what's left of them instead of listing them.
	const tag = usesD1(c.env) ? await ownerCodeTag(c.env) : null;
	const live = tag ? grants.filter((g) => g.metadata?.ownerCode === tag) : grants;
	if (tag) await Promise.all(grants.filter((g) => !live.includes(g)).map((g) => oauth.revokeGrant(g.id, user)));
	live.sort((a, b) => b.createdAt - a.createdAt);
	const items = await Promise.all(
		live.map(async (g) => ({ id: g.id, app: await appName(oauth, g.clientId), connected: new Date(g.createdAt * 1000).toISOString() })),
	);
	return c.json({ connections: items });
});

memoriesApp.delete("/connections/:id", async (c) => {
	const user = connectionsUser(await loadSession(c.env, c.req.raw));
	const oauth = (c.env as Env & { OAUTH_PROVIDER: OAuthHelpers }).OAUTH_PROVIDER;
	await oauth.revokeGrant(c.req.param("id"), user);
	return c.json({ ok: true });
});

memoriesApp.post("/signout", async (c) => {
	const handle = readCookie(c.req.raw, SESSION_COOKIE);
	if (handle) await dropState(c.env.OAUTH_KV, "session", handle);
	c.header("Set-Cookie", cookie(SESSION_COOKIE, "", 0));
	return c.json({ ok: true });
});

memoriesApp.onError((error, c) => {
	if (error instanceof SignInNeeded || (error instanceof DriveError && error.status === 401)) {
		return c.json({ error: "Your session ended. Sign in again.", signIn: true }, 401);
	}
	if (error instanceof UserFacingError) return c.json({ error: error.message }, error.status as 400);
	if (error instanceof SyntaxError) return c.json({ error: "Bad request." }, 400);
	console.error("memories page error", error instanceof DriveError ? `DriveError ${error.status}` : error instanceof Error ? error.name : typeof error);
	return c.json({ error: "Something went wrong. Try again in a minute." }, 500);
});

export { memoriesApp };
