// The sign-in step on one-click (D1) servers, before the passphrase. Used by both the Claude
// sign-in (auth.ts) and the memories page (memories.ts), each with its own short-lived state.
//
//   Unclaimed server: owner code, then the owner sets up a passkey or an authenticator app.
//                     From then on the owner code alone no longer signs in.
//   Claimed server:   a passkey, or the owner code plus a 6-digit authenticator code.
//
// The methods live in the server's D1 database next to the encrypted memories. They're tied to
// the owner code they were set up with: changing OWNER_CODE in the Cloudflare dashboard resets
// them, which is the way back in after losing every device.
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Context, Hono } from "hono";
import {
	type SignInMethods,
	authenticationOptions,
	b64urlEncode,
	checkTotp,
	deviceName,
	hasMethods,
	newTotpSecret,
	registrationOptions,
	relyingParty,
	totpUri,
	verifyAuthentication,
	verifyRegistration,
} from "./factors";
import { checkOwnerCode, d1, ownerCodeHash, recordFailure } from "./web";

/** What a sign-in in progress remembers between requests. */
export interface GateState {
	/** The passkey challenge just issued; each is used once. */
	challenge?: string;
	/** The owner code was right on an unclaimed server: the owner may set up a method. */
	claimOk?: boolean;
	userId?: string;
	/** An authenticator secret shown but not yet confirmed with a code. */
	totpSecret?: string;
}

export interface GateContext {
	state: GateState;
	save(state: GateState): Promise<void>;
	/** Signed in: finish the step (mark the Claude sign-in verified, or start a page session). */
	pass(): Promise<Response>;
}

// Hono's context type differs between the two apps that use these routes.
type AnyContext = Context<any>;
export type GateLoader = (c: AnyContext, body: Record<string, unknown>, starting: boolean) => Promise<GateContext | null>;

const origin = (c: AnyContext) => (c.env as Env).PUBLIC_URL || new URL(c.req.url).origin;


/** The server's sign-in methods; null when none are set up, or OWNER_CODE changed since. */
export async function loadMethods(env: Env): Promise<{ methods: SignInMethods | null; fileId: string | null }> {
	const storage = d1(env);
	const [file] = await storage.list("auth");
	if (!file) return { methods: null, fileId: null };
	const methods = JSON.parse(await storage.read(file.id)) as SignInMethods;
	const current = await ownerCodeHash(env);
	return { methods: current && methods.ownerCode === current ? methods : null, fileId: file.id };
}

async function saveMethods(env: Env, methods: SignInMethods, fileId: string | null) {
	const storage = d1(env);
	const body = JSON.stringify(methods);
	if (fileId) await storage.update(fileId, body);
	else await storage.create("auth", "sign-in.json", body);
}

/**
 * After a reset (OWNER_CODE changed), removes the connections made before it. They already
 * stopped working when the code changed; this deletes what's left of them in KV.
 */
async function endOldConnections(c: AnyContext) {
	const oauth = (c.env as { OAUTH_PROVIDER?: OAuthHelpers }).OAUTH_PROVIDER;
	if (!oauth) return;
	let cursor: string | undefined;
	do {
		const page = await oauth.listUserGrants("owner", { cursor });
		await Promise.all(page.items.map((g) => oauth.revokeGrant(g.id, "owner")));
		cursor = page.cursor;
	} while (cursor);
}

const newUserId = () => b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));

async function readBody(c: AnyContext): Promise<Record<string, unknown> | Response> {
	const sameOrigin = (c.req.header("Sec-Fetch-Site") ?? "same-origin") === "same-origin";
	if (!sameOrigin || !c.req.header("Content-Type")?.startsWith("application/json")) {
		return c.json({ error: "Not allowed." }, 403);
	}
	return (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
}

const EXPIRED = "This page expired. Start again.";

/** Registers the sign-in routes under prefix, e.g. /gate/connect or /memories/gate. */
export function gateRoutes(app: Hono<any>, prefix: string, loader: GateLoader) {
	async function begin(c: AnyContext, starting = false) {
		const body = await readBody(c);
		if (body instanceof Response) return body;
		const ctx = await loader(c, body, starting);
		if (!ctx) return c.json({ error: EXPIRED }, 400);
		return { body, ctx, env: c.env as Env, rp: relyingParty(origin(c)) };
	}

	// Which methods this server has, and a passkey challenge if it has passkeys.
	app.post(`${prefix}/start`, async (c) => {
		const s = await begin(c, true);
		if (s instanceof Response) return s;
		const { methods } = await loadMethods(s.env);
		if (!hasMethods(methods)) {
			await s.ctx.save({});
			return c.json({ claimed: false });
		}
		const options = methods.passkeys.length ? await authenticationOptions(s.rp, methods.passkeys) : null;
		await s.ctx.save({ challenge: options?.challenge });
		return c.json({ claimed: true, passkey: !!options, totp: !!methods.totp, options });
	});

	// Unclaimed: the owner code alone, to claim. Claimed: owner code plus authenticator code.
	app.post(`${prefix}/owner`, async (c) => {
		const s = await begin(c);
		if (s instanceof Response) return s;
		const { methods, fileId } = await loadMethods(s.env);
		if (hasMethods(methods) && !methods.totp) {
			return c.json({ error: "This server signs in with a passkey." }, 400);
		}
		const failed = await checkOwnerCode(s.env, c.req.raw, s.body.code);
		if (failed) return c.json({ error: failed.error }, failed.status);
		if (!hasMethods(methods)) {
			const userId = newUserId();
			const options = await registrationOptions(s.rp, userId, []);
			await s.ctx.save({ claimOk: true, userId, challenge: options.challenge });
			return c.json({ next: "enroll", options });
		}
		const step = await checkTotp(methods.totp!.secret, s.body.totp, methods.totp!.lastStep);
		if (step === null) {
			await recordFailure(s.env, c.req.raw);
			return c.json({ error: "That authenticator code is not correct, or was already used." }, 401);
		}
		await saveMethods(s.env, { ...methods, totp: { ...methods.totp!, lastStep: step } }, fileId);
		return s.ctx.pass();
	});

	app.post(`${prefix}/passkey`, async (c) => {
		const s = await begin(c);
		if (s instanceof Response) return s;
		const { methods, fileId } = await loadMethods(s.env);
		const challenge = s.ctx.state.challenge;
		if (!hasMethods(methods) || !challenge) return c.json({ error: EXPIRED }, 400);
		await s.ctx.save({ ...s.ctx.state, challenge: undefined }); // one use per challenge
		const used = await verifyAuthentication(s.rp, s.body.response, challenge, methods.passkeys).catch(() => null);
		if (!used) return c.json({ error: "That passkey didn't work for this server. Try again, or use another one." }, 401);
		await saveMethods(s.env, { ...methods, passkeys: methods.passkeys.map((p) => (p.id === used.id ? used : p)) }, fileId);
		return s.ctx.pass();
	});

	// Claiming: set up the first method, right after the owner code.
	async function claim(c: AnyContext) {
		const s = await begin(c);
		if (s instanceof Response) return s;
		if (!s.ctx.state.claimOk) return c.json({ error: EXPIRED }, 400);
		const { methods, fileId } = await loadMethods(s.env);
		if (hasMethods(methods)) return c.json({ error: "This server was just set up from somewhere else. Start again." }, 409);
		return { ...s, fileId, ownerCode: (await ownerCodeHash(s.env))! };
	}

	app.post(`${prefix}/enroll/passkey`, async (c) => {
		const s = await claim(c);
		if (s instanceof Response) return s;
		const { challenge, userId } = s.ctx.state;
		if (!challenge || !userId) return c.json({ error: EXPIRED }, 400);
		const passkey = await verifyRegistration(s.rp, s.body.response, challenge, deviceName(c.req.header("User-Agent"))).catch(() => null);
		if (!passkey) return c.json({ error: "The passkey couldn't be added. Try again." }, 400);
		await saveMethods(s.env, { v: 1, ownerCode: s.ownerCode, userId, passkeys: [passkey] }, s.fileId);
		await endOldConnections(c);
		return s.ctx.pass();
	});

	app.post(`${prefix}/enroll/totp`, async (c) => {
		const s = await claim(c);
		if (s instanceof Response) return s;
		const secret = newTotpSecret();
		await s.ctx.save({ ...s.ctx.state, totpSecret: secret });
		return c.json({ secret, uri: totpUri(secret, s.rp.id) });
	});

	app.post(`${prefix}/enroll/totp/confirm`, async (c) => {
		const s = await claim(c);
		if (s instanceof Response) return s;
		const secret = s.ctx.state.totpSecret;
		if (!secret) return c.json({ error: EXPIRED }, 400);
		const step = await checkTotp(secret, s.body.code, 0);
		if (step === null) {
			return c.json({ error: "That code doesn't match. Check that your phone sets its time automatically, then try the next code." }, 401);
		}
		const totp = { secret, created: new Date().toISOString(), lastStep: step };
		await saveMethods(s.env, { v: 1, ownerCode: s.ownerCode, userId: s.ctx.state.userId ?? newUserId(), passkeys: [], totp }, s.fileId);
		await endOldConnections(c);
		return s.ctx.pass();
	});
}

/** For managing methods while signed in: where a pending challenge or secret is kept. */
export interface ManageContext {
	state: GateState;
	save(state: GateState): Promise<void>;
	/** The owner confirmed with a passkey or codes in the last few minutes (see memories.ts). */
	confirmed: boolean;
}
export type ManageLoader = (c: AnyContext) => Promise<ManageContext | null>;

/**
 * Lists, adds and removes sign-in methods, for a signed-in owner (the memories page). Every
 * change needs a fresh confirmation, so a session left open can't plant a passkey of its own.
 */
export function manageRoutes(app: Hono<any>, prefix: string, loader: ManageLoader) {
	async function begin(c: AnyContext, json = true) {
		const body = json ? await readBody(c) : {};
		if (body instanceof Response) return body;
		const ctx = await loader(c);
		if (!ctx) return c.json({ error: "Your session ended. Sign in again.", signIn: true }, 401);
		if (json && !ctx.confirmed) return c.json({ error: "Confirm it's you first.", confirm: true }, 403);
		const env = c.env as Env;
		const { methods, fileId } = await loadMethods(env);
		if (!hasMethods(methods)) return c.json({ error: "Your session ended. Sign in again.", signIn: true }, 401);
		return { body, ctx, env, methods, fileId, rp: relyingParty(origin(c)) };
	}

	// confirmed: whether changes are allowed right now, so the page can ask first.
	const summary = (m: SignInMethods, confirmed: boolean) => ({
		passkeys: m.passkeys.map(({ id, name, created, lastUsed }) => ({ id, name, created, lastUsed })),
		totp: m.totp ? { created: m.totp.created } : null,
		confirmed,
	});

	app.get(prefix, async (c) => {
		const s = await begin(c, false);
		if (s instanceof Response) return s;
		return c.json(summary(s.methods, s.ctx.confirmed));
	});

	app.post(`${prefix}/passkey/options`, async (c) => {
		const s = await begin(c);
		if (s instanceof Response) return s;
		const options = await registrationOptions(s.rp, s.methods.userId, s.methods.passkeys);
		await s.ctx.save({ ...s.ctx.state, challenge: options.challenge });
		return c.json(options);
	});

	app.post(`${prefix}/passkey`, async (c) => {
		const s = await begin(c);
		if (s instanceof Response) return s;
		const challenge = s.ctx.state.challenge;
		if (!challenge) return c.json({ error: EXPIRED }, 400);
		await s.ctx.save({ ...s.ctx.state, challenge: undefined });
		const passkey = await verifyRegistration(s.rp, s.body.response, challenge, deviceName(c.req.header("User-Agent"))).catch(() => null);
		if (!passkey) return c.json({ error: "The passkey couldn't be added. Try again." }, 400);
		const next = { ...s.methods, passkeys: [...s.methods.passkeys.filter((p) => p.id !== passkey.id), passkey] };
		await saveMethods(s.env, next, s.fileId);
		return c.json(summary(next, s.ctx.confirmed));
	});

	app.delete(`${prefix}/passkey/:id`, async (c) => {
		const s = await begin(c);
		if (s instanceof Response) return s;
		const passkeys = s.methods.passkeys.filter((p) => p.id !== c.req.param("id"));
		if (!passkeys.length && !s.methods.totp) {
			return c.json({ error: "This is your only way to sign in. Add another passkey or an authenticator app first." }, 409);
		}
		const next = { ...s.methods, passkeys };
		await saveMethods(s.env, next, s.fileId);
		return c.json(summary(next, s.ctx.confirmed));
	});

	app.post(`${prefix}/totp`, async (c) => {
		const s = await begin(c);
		if (s instanceof Response) return s;
		const secret = newTotpSecret();
		await s.ctx.save({ ...s.ctx.state, totpSecret: secret });
		return c.json({ secret, uri: totpUri(secret, s.rp.id) });
	});

	app.post(`${prefix}/totp/confirm`, async (c) => {
		const s = await begin(c);
		if (s instanceof Response) return s;
		const secret = s.ctx.state.totpSecret;
		if (!secret) return c.json({ error: EXPIRED }, 400);
		const step = await checkTotp(secret, s.body.code, 0);
		if (step === null) {
			return c.json({ error: "That code doesn't match. Check that your phone sets its time automatically, then try the next code." }, 401);
		}
		await s.ctx.save({ ...s.ctx.state, totpSecret: undefined });
		const next = { ...s.methods, totp: { secret, created: new Date().toISOString(), lastStep: step } };
		await saveMethods(s.env, next, s.fileId);
		return c.json(summary(next, s.ctx.confirmed));
	});

	app.delete(`${prefix}/totp`, async (c) => {
		const s = await begin(c);
		if (s instanceof Response) return s;
		if (!s.methods.passkeys.length) {
			return c.json({ error: "This is your only way to sign in. Add a passkey first." }, 409);
		}
		const { totp: _, ...next } = s.methods;
		await saveMethods(s.env, next, s.fileId);
		return c.json(summary(next, s.ctx.confirmed));
	});
}
